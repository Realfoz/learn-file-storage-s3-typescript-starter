import { respondWithJSON } from "./json";
import { type ApiConfig } from "../config";
import { file, s3, S3Client, type BunRequest } from "bun";
import { BadRequestError, UserForbiddenError } from "./errors";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo, type Video } from "../db/videos";
import { randomBytes } from "crypto";
import path from "path";
import fs from 'fs';
import { type } from "os";

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
   const { videoId } = req.params as { videoId?: string }; //checked routing, this is the correct path
      if (!videoId) {
        throw new BadRequestError("Invalid video ID");
      }

    const token = getBearerToken(req.headers);
        const userID = validateJWT(token, cfg.jwtSecret);
        console.log("uploading video", videoId, "by user", userID);

    console.log("auth:", getBearerToken(req.headers)) //debugging
    
    const formData = await req.formData(); 
    const file = formData.get("video"); 
    if (!file || !(file instanceof File)) {throw new BadRequestError("Invalid File")}

    const MAX_UPLOAD_SIZE = 1 << 30; //bitwise magical bullshit. tl:dr its 1GB
    if (file.size > MAX_UPLOAD_SIZE) {throw new BadRequestError("File size to large. Files are limited to 1GB")}

    let videoMetaData = getVideo(cfg.db, videoId) //gets the videos metadata from the db and video id
    if (userID !== videoMetaData?.userID) {throw new UserForbiddenError("Invalid userId for this request")}  
    
    let fileType = ""
    const mimeType = file.type
    if (mimeType !== "video/mp4") {
      throw new BadRequestError("Invalid file type") //we only accept mp4 currently, if we add more make a record like the thumbnail handler
    } else {
      fileType = "mp4"
    }
    const fileByteArray = await file.arrayBuffer() //creates a byte array of the video
    const randomString = randomBytes(32).toString("base64url") //creates a random 32 byte buffer and stringifies it to be the file path
    const tempKey = `${randomString}.${fileType}`
    const tempFile = path.join(cfg.assetsRoot, tempKey)
    await Bun.write(tempFile,fileByteArray) //adds local save copy

    const fastStart = await processVideoForFastStart(tempFile);

    const aspectRatio = await getVideoAspectRatio(fastStart) //gets aspect ratio of fast start version
    const key = `${aspectRatio}/${tempKey}`
    
    const s3File = cfg.s3Client.file(key) 
    await s3File.write(Bun.file(fastStart),{type: mimeType}) //uploads the fast start version but keeps the old name

    videoMetaData.videoURL = key
    updateVideo(cfg.db, videoMetaData)
    const presignedVideo = await dbVideoToSignedVideo(cfg, videoMetaData)

    await Bun.file(tempFile).delete(); //removes local file once upload is done
    await Bun.file(fastStart).delete(); //removes fst start local file

  return respondWithJSON(200, presignedVideo );
}

export async function getVideoAspectRatio(filepath: string) {
  const path = fs.statSync(filepath)
  if (!path || !path.isFile()) {
    throw new BadRequestError("Invalid File Path")
  }
  let process = Bun.spawn([ //runs this in the terminal and we can pipe stuff in and out
    "ffprobe",
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height",
    "-of",
    "json",
    filepath
  ],{
    stdout: "pipe", //output
    stderr: "pipe" //errors
  })
  const output = await new Response(process.stdout).text(); //saves the output stringified json from the process
  const errors = await new Response(process.stderr).text();
  await process.exited //waits for the process to finish so we can check the code

  if (errors||!output|| process.exitCode !== 0) {throw new BadRequestError("Invalid file")} //err on any err msg, no output or a failed exit code

  const data = JSON.parse(output) //converts the stringified version into a json
  const width = data.streams[0].width
  const height = data.streams[0].height
  const aspectRatio = width / height 
  
  if (aspectRatio > 1.1) {
    return "landscape"
  } else if (aspectRatio < 0.9) {
    return "portrait"
  } else {
    return "other"
  }  
}

export async function processVideoForFastStart(filepath: string) {
    const path = fs.statSync(filepath)
  if (!path || !path.isFile()) {
    throw new BadRequestError("Invalid File Path")
  }
  const newFilePath = `${filepath}.processed` 
  let process = Bun.spawn([
    "ffmpeg",
    "-i",
    filepath,
    "-movflags",
    "faststart",
    "-map_metadata",
    "0",
    "-codec",
    "copy",
    "-f",
    "mp4",
    newFilePath
  ])
 
await process.exited;
if (process.exitCode !== 0) {
  throw new BadRequestError("ffmpeg failed");
}
const out = await fs.promises.stat(newFilePath).catch(() => null);
if (!out || !out.isFile() || out.size <= 0) {
  throw new BadRequestError("Processed file missing or empty");
}
return newFilePath;
}

async function generatePresignedURL(cfg:ApiConfig, key:string, expireTime:number) {
  return await cfg.s3Client.presign(key, {
  expiresIn: expireTime,
  method: "GET",
  });
}

 export async function dbVideoToSignedVideo(cfg: ApiConfig, video: Video){
  let key = video.videoURL
  if (!key || typeof key !== "string"|| key.trim() === "") {
    return video
  }
  const presignedURL = await generatePresignedURL(cfg,key,cfg.signedUrlTTLSeconds)
  return {...video, videoURL: presignedURL}
}