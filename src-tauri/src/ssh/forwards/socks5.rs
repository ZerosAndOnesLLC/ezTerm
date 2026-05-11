//! Minimal SOCKS5 server-side helpers for the Dynamic (`-D`) forward.
//! No I/O lives here — parsers take `&[u8]`, encoders return small
//! fixed-size arrays. Only the bits the spec calls out: greeting +
//! CONNECT request. See spec §"Dynamic forwards" for the wire format
//! we accept/reject.

use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum Socks5Error {
    #[error("short read")]
    Short,
    #[error("unsupported SOCKS version: {0}")]
    BadVersion(u8),
    #[error("unsupported address type: {0}")]
    BadAtyp(u8),
    #[error("unsupported command: {0}")]
    BadCommand(u8),
    #[error("no acceptable auth method")]
    NoAuth,
    #[error("invalid domain length")]
    BadDomain,
}

/// Parsed CONNECT request. We only support CMD = 01 (CONNECT).
#[derive(Debug, PartialEq, Eq)]
pub struct ConnectRequest {
    pub host: String,
    pub port: u16,
}

/// Parse the SOCKS5 greeting (`VER NMETHODS METHODS...`). Returns Ok(())
/// if `0x00` (no-auth) is offered; otherwise `Err(NoAuth)`.
pub fn parse_greeting(buf: &[u8]) -> Result<(), Socks5Error> {
    if buf.len() < 2 { return Err(Socks5Error::Short); }
    if buf[0] != 0x05 { return Err(Socks5Error::BadVersion(buf[0])); }
    let nmethods = buf[1] as usize;
    if buf.len() < 2 + nmethods { return Err(Socks5Error::Short); }
    if buf[2..2 + nmethods].contains(&0x00) {
        Ok(())
    } else {
        Err(Socks5Error::NoAuth)
    }
}

/// Greeting reply: `[VER, METHOD]`. `accept = true` ⇒ 0x00 (no auth);
/// false ⇒ 0xFF (no acceptable methods).
pub fn encode_greeting_reply(accept: bool) -> [u8; 2] {
    [0x05, if accept { 0x00 } else { 0xFF }]
}

/// Parse the SOCKS5 request (`VER CMD RSV ATYP DST.ADDR DST.PORT`).
pub fn parse_request(buf: &[u8]) -> Result<ConnectRequest, Socks5Error> {
    if buf.len() < 4 { return Err(Socks5Error::Short); }
    if buf[0] != 0x05 { return Err(Socks5Error::BadVersion(buf[0])); }
    if buf[1] != 0x01 { return Err(Socks5Error::BadCommand(buf[1])); }
    // buf[2] reserved, ignore.
    let (host, port_off) = match buf[3] {
        0x01 => {
            // IPv4
            if buf.len() < 4 + 4 + 2 { return Err(Socks5Error::Short); }
            let ip = std::net::Ipv4Addr::new(buf[4], buf[5], buf[6], buf[7]);
            (ip.to_string(), 4 + 4)
        }
        0x03 => {
            // Domain — first byte is length.
            if buf.len() < 5 { return Err(Socks5Error::Short); }
            let len = buf[4] as usize;
            if len == 0 { return Err(Socks5Error::BadDomain); }
            if buf.len() < 5 + len + 2 { return Err(Socks5Error::Short); }
            let domain = std::str::from_utf8(&buf[5..5 + len])
                .map_err(|_| Socks5Error::BadDomain)?
                .to_string();
            (domain, 5 + len)
        }
        0x04 => {
            // IPv6
            if buf.len() < 4 + 16 + 2 { return Err(Socks5Error::Short); }
            let mut octets = [0u8; 16];
            octets.copy_from_slice(&buf[4..20]);
            let ip = std::net::Ipv6Addr::from(octets);
            (ip.to_string(), 4 + 16)
        }
        atyp => return Err(Socks5Error::BadAtyp(atyp)),
    };
    let port = u16::from_be_bytes([buf[port_off], buf[port_off + 1]]);
    Ok(ConnectRequest { host, port })
}

/// Reply byte codes (RFC 1928 §6). We only need the ones we currently
/// emit — others can be added if the dispatch ever needs to distinguish
/// e.g. host-unreachable from connection-refused.
pub mod rep {
    pub const SUCCESS:                    u8 = 0x00;
    pub const GENERAL_FAILURE:            u8 = 0x01;
    pub const CONNECTION_REFUSED:         u8 = 0x05;
    pub const COMMAND_NOT_SUPPORTED:      u8 = 0x07;
    pub const ADDRESS_TYPE_NOT_SUPPORTED: u8 = 0x08;
}

/// Encode a CONNECT reply: `[VER, REP, RSV, ATYP=0x01, BND.ADDR(4)=0,
/// BND.PORT(2)=0]`. We always report `0.0.0.0:0` because russh doesn't
/// expose the locally-bound socket; well-behaved clients accept this
/// per RFC 1928.
pub fn encode_reply(rep: u8) -> [u8; 10] {
    [0x05, rep, 0x00, 0x01, 0, 0, 0, 0, 0, 0]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn greeting_accepts_no_auth() {
        assert_eq!(parse_greeting(&[0x05, 0x01, 0x00]), Ok(()));
        assert_eq!(parse_greeting(&[0x05, 0x02, 0x02, 0x00]), Ok(()));
    }

    #[test]
    fn greeting_rejects_auth_only() {
        assert_eq!(parse_greeting(&[0x05, 0x01, 0x02]), Err(Socks5Error::NoAuth));
    }

    #[test]
    fn greeting_short() {
        assert_eq!(parse_greeting(&[0x05]), Err(Socks5Error::Short));
        assert_eq!(parse_greeting(&[0x05, 0x02, 0x00]), Err(Socks5Error::Short));
    }

    #[test]
    fn greeting_bad_version() {
        assert_eq!(parse_greeting(&[0x04, 0x01, 0x00]), Err(Socks5Error::BadVersion(4)));
    }

    #[test]
    fn request_ipv4() {
        let buf = [0x05, 0x01, 0x00, 0x01, 1, 2, 3, 4, 0x00, 0x50];
        assert_eq!(parse_request(&buf), Ok(ConnectRequest { host: "1.2.3.4".into(), port: 80 }));
    }

    #[test]
    fn request_domain() {
        let mut buf = vec![0x05, 0x01, 0x00, 0x03, 11];
        buf.extend_from_slice(b"example.com");
        buf.extend_from_slice(&[0x01, 0xBB]);
        assert_eq!(parse_request(&buf), Ok(ConnectRequest { host: "example.com".into(), port: 443 }));
    }

    #[test]
    fn request_ipv6() {
        let mut buf = vec![0x05, 0x01, 0x00, 0x04];
        buf.extend_from_slice(&[0xfe,0x80,0,0,0,0,0,0,0,0,0,0,0,0,0,1]);
        buf.extend_from_slice(&[0x00, 0x50]);
        assert_eq!(parse_request(&buf), Ok(ConnectRequest { host: "fe80::1".into(), port: 80 }));
    }

    #[test]
    fn request_unsupported_command() {
        let buf = [0x05, 0x02, 0x00, 0x01, 1, 1, 1, 1, 0, 0]; // BIND
        assert_eq!(parse_request(&buf), Err(Socks5Error::BadCommand(2)));
    }

    #[test]
    fn request_unsupported_atyp() {
        let buf = [0x05, 0x01, 0x00, 0x05, 0, 0, 0, 0];
        assert_eq!(parse_request(&buf), Err(Socks5Error::BadAtyp(5)));
    }

    #[test]
    fn request_empty_domain_rejected() {
        let buf = [0x05, 0x01, 0x00, 0x03, 0x00];
        assert_eq!(parse_request(&buf), Err(Socks5Error::BadDomain));
    }

    #[test]
    fn request_short() {
        assert_eq!(parse_request(&[0x05, 0x01, 0x00]), Err(Socks5Error::Short));
        assert_eq!(parse_request(&[0x05, 0x01, 0x00, 0x03, 5, b'a']), Err(Socks5Error::Short));
    }

    #[test]
    fn reply_encoding() {
        assert_eq!(encode_reply(rep::SUCCESS), [0x05, 0, 0, 0x01, 0, 0, 0, 0, 0, 0]);
        assert_eq!(encode_greeting_reply(true),  [0x05, 0x00]);
        assert_eq!(encode_greeting_reply(false), [0x05, 0xFF]);
    }
}
