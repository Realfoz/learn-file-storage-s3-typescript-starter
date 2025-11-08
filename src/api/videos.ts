import { respondWithJSON } from "./json";
import { type ApiConfig } from "../config";
import { s3, S3Client, type BunRequest } from "bun";
import { BadRequestError, UserForbiddenError } from "./errors";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo } from "../db/videos";
import { randomBytes } from "crypto";
import path from "path";

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
   const { videoId } = req.params as { videoId?: string }; //checkedd routing, this is the correct path
      if (!videoId) {
        throw new BadRequestError("Invalid video ID");
      }

    console.log("params:", req.params) //debugging

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
    const key = `${randomString}.${fileType}`
    const tempFile = path.join(cfg.assetsRoot, key)
    await Bun.write(tempFile,fileByteArray) //adds local save copy
    
    const s3File = cfg.s3Client.file(key) 
    await s3File.write(Bun.file(tempFile),{type: mimeType})

    videoMetaData.videoURL = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${key}`
    updateVideo(cfg.db, videoMetaData)

     const check = getVideo(cfg.db, videoId); //debugging
     console.log(check?.videoURL);

    await Bun.file(tempFile).delete(); //removes local file once upload is done

  return respondWithJSON(200, videoMetaData );
}
