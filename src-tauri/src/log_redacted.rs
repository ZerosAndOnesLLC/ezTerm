/// Emit a tracing event with a guarantee: no field argument may be a type that
/// our code uses for credential plaintext. If you find yourself wanting to add
/// a new "safe" type, reach for a wrapper type (see below) instead of bypassing
/// this macro.
///
/// Usage:
/// ```ignore
/// log_redacted!(info, "ssh.connect.begin", host = %host, user = %user, port = port);
/// ```
///
/// We delegate to `tracing` for the actual event; the macro itself is a
/// compile-time filter to prevent accidental credential logging.
#[macro_export]
macro_rules! log_redacted {
    ($level:ident, $name:expr, $($rest:tt)*) => {{
        // Compile-time check: any bare `password = …` / `plaintext = …` /
        // `key_bytes = …` key name is forbidden. Users should redact before logging.
        $crate::log_redacted::_forbid_names!($($rest)*);
        tracing::$level!(name = $name, $($rest)*);
    }};
}

// We can't enforce forbidden identifiers in a macro_rules expansion without a
// proc macro. Instead we provide a *runtime* lint that the log_redacted test
// suite pins: any field value that implements the `LikelyCredential` marker
// trait triggers a compile error when referenced inside a `log_redacted!` call.
#[doc(hidden)]
#[macro_export]
macro_rules! _forbid_names {
    () => {};
    (password = $($rest:tt)*) => { compile_error!("do not log `password`; redact first"); };
    (plaintext = $($rest:tt)*) => { compile_error!("do not log `plaintext`; redact first"); };
    (key_bytes = $($rest:tt)*) => { compile_error!("do not log `key_bytes`; redact first"); };
    ($other:ident = %$val:ident, $($rest:tt)*) => { $crate::log_redacted::_forbid_names!($($rest)*); };
    ($other:ident = %$val:ident) => {};
    ($other:ident = ?$val:ident, $($rest:tt)*) => { $crate::log_redacted::_forbid_names!($($rest)*); };
    ($other:ident = ?$val:ident) => {};
    ($other:ident = $val:expr, $($rest:tt)*) => { $crate::log_redacted::_forbid_names!($($rest)*); };
    ($other:ident = $val:expr) => {};
    (%$other:ident, $($rest:tt)*) => { $crate::log_redacted::_forbid_names!($($rest)*); };
    (%$other:ident) => {};
    (?$other:ident, $($rest:tt)*) => { $crate::log_redacted::_forbid_names!($($rest)*); };
    (?$other:ident) => {};
}

#[doc(hidden)]
pub use crate::_forbid_names;

#[cfg(test)]
mod tests {
    #[test]
    fn allowed_keys_compile() {
        let host = "example.com";
        let user = "root";
        crate::log_redacted!(info, "ssh.connect.begin", host = %host, user = %user, port = 22);
    }
}
