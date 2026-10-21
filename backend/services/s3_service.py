"""
S3 service — uploads files to the ethosh-qualilab-server bucket.

Key structure:
  uploads/<user_id>/<uuid>_<original_filename>

For anonymous (unauthenticated) uploads the user segment is "anonymous".

Uses its own S3-specific AWS credentials (separate from Bedrock credentials).
"""

import logging
import uuid

import boto3
from botocore.exceptions import BotoCoreError, ClientError

from config import S3_AWS_ACCESS_KEY_ID, S3_AWS_SECRET_ACCESS_KEY, S3_AWS_REGION, S3_BUCKET_NAME

logger = logging.getLogger(__name__)

_s3_client = None


def _get_client():
    global _s3_client
    if _s3_client is not None:
        return _s3_client

    _s3_client = boto3.client(
        "s3",
        region_name=S3_AWS_REGION,
        aws_access_key_id=S3_AWS_ACCESS_KEY_ID,
        aws_secret_access_key=S3_AWS_SECRET_ACCESS_KEY,
    )
    return _s3_client


def _bucket() -> str:
    name = (S3_BUCKET_NAME or "").strip()
    if not name:
        raise RuntimeError(
            "S3_BUCKET_NAME is not set. "
            "Add S3_BUCKET_NAME=ethosh-qualilab-server to your .env file."
        )
    return name


def upload_file(
    file_data: bytes,
    filename: str,
    content_type: str = "application/pdf",
    user_id: str = "anonymous",
) -> str:
    client = _get_client()
    bucket = _bucket()
    region = S3_AWS_REGION

    unique_prefix = uuid.uuid4().hex[:12]
    safe_name = filename.replace(" ", "_")
    key = f"uploads/{user_id}/{unique_prefix}_{safe_name}"

    logger.info("[s3] uploading %d bytes → s3://%s/%s", len(file_data), bucket, key)

    try:
        client.put_object(
            Bucket=bucket,
            Key=key,
            Body=file_data,
            ContentType=content_type,
            Tagging="app=qualilab&env=production",
        )
    except (ClientError, BotoCoreError) as exc:
        logger.error("[s3] upload failed: %s", exc)
        raise RuntimeError(f"S3 upload failed: {exc}") from exc

    url = f"https://{bucket}.s3.{region}.amazonaws.com/{key}"
    logger.info("[s3] upload complete → %s", url)
    return url


def get_presigned_url(key: str, expiry_seconds: int = 3600) -> str:
    client = _get_client()
    bucket = _bucket()

    try:
        url = client.generate_presigned_url(
            "get_object",
            Params={"Bucket": bucket, "Key": key},
            ExpiresIn=expiry_seconds,
        )
    except (ClientError, BotoCoreError) as exc:
        logger.error("[s3] presign failed for key=%s: %s", key, exc)
        raise RuntimeError(f"Failed to generate pre-signed URL: {exc}") from exc

    return url


def delete_file(key: str) -> None:
    client = _get_client()
    bucket = _bucket()

    try:
        client.delete_object(Bucket=bucket, Key=key)
        logger.info("[s3] deleted s3://%s/%s", bucket, key)
    except (ClientError, BotoCoreError) as exc:
        logger.warning("[s3] delete failed for key=%s: %s", key, exc)
