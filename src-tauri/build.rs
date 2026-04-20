fn main() {
    // Ensure the frontend output directory exists before `tauri::generate_context!`
    // in main.rs runs its compile-time path check. On fresh clones, `ui/out/` is
    // gitignored and doesn't exist yet; a real `npm run build` (or `cargo tauri dev`'s
    // beforeDevCommand) will overwrite this stub with the real static export.
    let dist = std::path::Path::new("../ui/out");
    if !dist.exists() {
        let _ = std::fs::create_dir_all(dist);
        let stub = dist.join("index.html");
        if !stub.exists() {
            let _ = std::fs::write(
                &stub,
                concat!(
                    "<!doctype html><meta charset=utf-8><title>ezTerm</title>",
                    "<body style=\"font-family:system-ui;background:#121214;color:#e5e7eb;padding:2rem\">",
                    "<h1>ezTerm frontend not built</h1>",
                    "<p>Run <code>npm --prefix ui install &amp;&amp; npm --prefix ui run build</code> ",
                    "then rebuild, or use <code>cargo tauri dev</code> which does this for you.</p>",
                    "</body>"
                ),
            );
        }
    }
    tauri_build::build();
}
