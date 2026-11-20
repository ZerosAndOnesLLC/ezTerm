use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

use crate::error::{AppError, Result};

/// Longest URL we hand to the OS. Browsers accept more, but a terminal link
/// longer than this is far more likely to be garbage than a real address.
const MAX_URL_LEN: usize = 8 * 1024;

/// Accept only absolute `http` / `https` URLs with a host. Terminal output is
/// untrusted (any remote host can print an OSC 8 hyperlink), so `file:`,
/// `javascript:`, custom protocol handlers and the like are refused here
/// rather than relying on the frontend to filter them.
fn validate_web_url(raw: &str) -> Result<reqwest::Url> {
    if raw.len() > MAX_URL_LEN {
        return Err(AppError::Validation("link is too long".into()));
    }
    let url =
        reqwest::Url::parse(raw.trim()).map_err(|_| AppError::Validation("invalid link".into()))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(AppError::Validation(
            "only http and https links can be opened".into(),
        ));
    }
    if url.host_str().is_none_or(str::is_empty) {
        return Err(AppError::Validation("link has no host".into()));
    }
    Ok(url)
}

/// Open a terminal link in the user's default browser.
///
/// Not gated on `require_unlocked`: it only reads the URL it is given and
/// exposes no vault data.
#[tauri::command]
pub fn open_url(app: AppHandle, url: String) -> Result<()> {
    let url = validate_web_url(&url)?;
    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|e| AppError::Validation(format!("could not open link: {e}")))
}

#[cfg(test)]
mod tests {
    use super::validate_web_url;

    #[test]
    fn accepts_http_and_https() {
        assert!(validate_web_url("https://example.com/a?b=c#d").is_ok());
        assert!(validate_web_url("http://10.0.0.5:8080/").is_ok());
        assert!(validate_web_url("  https://example.com  ").is_ok());
    }

    #[test]
    fn rejects_other_schemes() {
        for bad in [
            "file:///C:/Windows/System32/calc.exe",
            "javascript:alert(1)",
            "ms-settings:privacy",
            "ftp://example.com/",
            "mailto:someone@example.com",
        ] {
            assert!(validate_web_url(bad).is_err(), "{bad} should be rejected");
        }
    }

    #[test]
    fn rejects_garbage_and_oversized() {
        assert!(validate_web_url("not a url").is_err());
        assert!(validate_web_url("").is_err());
        let long = format!("https://example.com/{}", "a".repeat(9000));
        assert!(validate_web_url(&long).is_err());
    }
}
