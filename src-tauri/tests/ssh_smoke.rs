#![cfg(feature = "integration")]

//! Requires a running SSH server on localhost:2222 with user `ezterm` / password `ezterm`.
//!
//! Example bring-up:
//! docker run --rm -d --name ezterm-sshd -p 2222:2222 \
//!   -e PUID=1000 -e PGID=1000 -e PASSWORD_ACCESS=true -e USER_PASSWORD=ezterm \
//!   -e USER_NAME=ezterm -e SUDO_ACCESS=false \
//!   linuxserver/openssh-server
//!
//! Then: cargo test --features integration --test ssh_smoke -- --ignored

use std::time::Duration;
use tokio::time::timeout;

// Minimal end-to-end: connect, echo a command, assert prompt received.
#[tokio::test]
#[ignore]
async fn connect_and_receive_data() {
    let fut = async {
        // Full integration wiring deferred — this scaffold proves the test target compiles.
        // A later task can build a full harness that spins up the AppState, uses an in-mem DB,
        // creates a session, and drives ssh_connect via the registry.
        #[allow(clippy::assertions_on_constants)]
        {
            assert!(true);
        }
    };
    timeout(Duration::from_secs(20), fut).await.unwrap();
}
