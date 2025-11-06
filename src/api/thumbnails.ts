import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo } from "../db/videos";
import type { ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import path from "path";
import { randomBytes } from "crypto";

const fileTypeRecord: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp"
}

function extensionFromMime(mime: string): string {
  const ext = fileTypeRecord[mime]
   if (!ext) throw new BadRequestError("Unsupported image type");
  return ext;
}


export async function handlerUploadThumbnail(cfg: ApiConfig, req: BunRequest) {
    const { videoId } = req.params as { videoId?: string };
    if (!videoId) {
      throw new BadRequestError("Invalid video ID");
    }
    const token = getBearerToken(req.headers);
    const userID = validateJWT(token, cfg.jwtSecret);
    console.log("uploading thumbnail for video", videoId, "by user", userID);
    const formData = await req.formData(); // gets the form data and parses it
    const file = formData.get("thumbnail"); //gets just the thumbnail from the form data
    if (!file || !(file instanceof File)) {throw new BadRequestError("Invalid File")}
    
    const MAX_UPLOAD_SIZE = 10 << 20; //bitwise magical bullshit. tl:dr its 10MB
    if (file.size > MAX_UPLOAD_SIZE) {throw new BadRequestError("File size to large. Files are limited to 10MB")}
   
    const fileType = extensionFromMime(file.type)
    const fileByteArray = await file.arrayBuffer() //creates a byte array of the image
    const randomString = randomBytes(32).toString("base64url") //creates a random 32 byte buffer and stringifies it to be the file path
    const fileURL = path.join(cfg.assetsRoot,`${randomString}.${fileType}`)
   
    await Bun.write(fileURL,fileByteArray)
    
    let videoMetaData = getVideo(cfg.db, videoId) //gets the videos metadata from the db and video id
    if (userID !== videoMetaData?.userID) {throw new UserForbiddenError("Invalid userId for this request")}

    videoMetaData.thumbnailURL = `http://localhost:${cfg.port}/assets/${randomString}.${fileType}`
    updateVideo(cfg.db, videoMetaData)

  return respondWithJSON(200, videoMetaData);
}
