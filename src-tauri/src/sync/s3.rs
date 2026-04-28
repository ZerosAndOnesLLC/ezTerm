//! S3-compatible cloud sync driver (phase 2).
//!
//! Narrow scope — we only need PUT/HEAD/GET on a single object per
//! configured bucket. Supports AWS S3, Cloudflare R2, Backblaze B2,
//! Wasabi, DigitalOcean Spaces, MinIO, SeaweedFS, and any other service
//! speaking the S3 API. Uses path-style addressing by default so R2 /
//! MinIO work out of the box; AWS accepts path-style too.

use s3::{creds::Credentials, Bucket, Region};

use crate::error::{AppError, Result};

/// The single object key per bucket (joined with the user's prefix).
const OBJECT_NAME: &str = "ezterm-sync.json";

pub struct S3Driver {
    bucket: Box<Bucket>,
    key: String,
}

pub struct S3Config<'a> {
    pub endpoint:         &'a str,
    pub region:           &'a str,
    pub bucket:           &'a str,
    pub prefix:           &'a str,
    pub access_key_id:    &'a str,
    pub secret_access_key: &'a str,
}

impl S3Driver {
    pub fn new(cfg: S3Config<'_>) -> Result<Self> {
        let region = Region::Custom {
            region:   cfg.region.to_string(),
            endpoint: cfg.endpoint.to_string(),
        };
        let creds = Credentials::new(
            Some(cfg.access_key_id),
            Some(cfg.secret_access_key),
            None,
            None,
            None,
        )
        .map_err(|e| AppError::Validation(format!("s3 creds: {e}")))?;
        let bucket = Bucket::new(cfg.bucket, region, creds)
            .map_err(|e| AppError::Validation(format!("s3 bucket: {e}")))?
            .with_path_style();
        let key = join_prefix_key(cfg.prefix, OBJECT_NAME);
        Ok(Self { bucket, key })
    }

    /// PUT the bytes unconditionally. Returns the server's ETag (unquoted).
    pub async fn put(&self, body: &[u8]) -> Result<String> {
        let resp = self
            .bucket
            .put_object(&self.key, body)
            .await
            .map_err(|e| AppError::Ssh(format!("s3 put: {e}")))?;
        let code = resp.status_code();
        if !(200..300).contains(&code) {
            return Err(AppError::Ssh(format!(
                "s3 put returned HTTP {code}: {}",
                String::from_utf8_lossy(resp.as_slice())
            )));
        }
        extract_etag(&resp.headers())
            .ok_or_else(|| AppError::Ssh("s3 put: no ETag in response".into()))
    }

    /// HEAD the object. Returns `Some(etag)` if it exists, `None` for 404.
    pub async fn head(&self) -> Result<Option<String>> {
        let (_head, code) = self
            .bucket
            .head_object(&self.key)
            .await
            .map_err(|e| AppError::Ssh(format!("s3 head: {e}")))?;
        if code == 404 {
            return Ok(None);
        }
        if !(200..300).contains(&code) {
            return Err(AppError::Ssh(format!("s3 head returned HTTP {code}")));
        }
        // rust-s3's HeadObjectResult exposes e_tag as Option<String>.
        Ok(_head.e_tag.map(|s| s.trim_matches('"').to_string()))
    }

    /// GET the object body. Returns `Some(bytes, etag)` or `None` on 404.
    pub async fn get(&self) -> Result<Option<(Vec<u8>, String)>> {
        let resp = self
            .bucket
            .get_object(&self.key)
            .await
            .map_err(|e| AppError::Ssh(format!("s3 get: {e}")))?;
        let code = resp.status_code();
        if code == 404 {
            return Ok(None);
        }
        if !(200..300).contains(&code) {
            return Err(AppError::Ssh(format!("s3 get returned HTTP {code}")));
        }
        let etag = extract_etag(&resp.headers())
            .unwrap_or_default();
        Ok(Some((resp.bytes().to_vec(), etag)))
    }
}

fn join_prefix_key(prefix: &str, name: &str) -> String {
    let p = prefix.trim().trim_matches('/');
    if p.is_empty() {
        name.to_string()
    } else {
        format!("{p}/{name}")
    }
}

fn extract_etag(headers: &std::collections::HashMap<String, String>) -> Option<String> {
    headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("etag"))
        .map(|(_, v)| v.trim_matches('"').to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefix_joining() {
        assert_eq!(join_prefix_key("", "x.json"), "x.json");
        assert_eq!(join_prefix_key("foo", "x.json"), "foo/x.json");
        assert_eq!(join_prefix_key("foo/", "x.json"), "foo/x.json");
        assert_eq!(join_prefix_key("/foo/", "x.json"), "foo/x.json");
        assert_eq!(join_prefix_key("nested/path", "x.json"), "nested/path/x.json");
    }

    #[test]
    fn etag_extraction_unquotes_and_is_case_insensitive() {
        let mut h = std::collections::HashMap::new();
        h.insert("ETag".into(), "\"abc123\"".into());
        assert_eq!(extract_etag(&h).as_deref(), Some("abc123"));

        let mut h = std::collections::HashMap::new();
        h.insert("etag".into(), "xyz".into());
        assert_eq!(extract_etag(&h).as_deref(), Some("xyz"));
    }
}
