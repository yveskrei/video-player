// Wires the statically-built FFmpeg into the rustc link line.
// build_library.sh exports FFMPEG_DIR and DEPS_DIR plus the per-library RUSTFLAGS;
// this file only registers the search paths and a system lib pkg-config misses.

fn main() {
    let ffmpeg_dir = std::env::var("FFMPEG_DIR")
        .expect("FFMPEG_DIR not set — build via ./build_library.sh");
    let deps_dir = std::env::var("DEPS_DIR").unwrap_or_else(|_| {
        let project_root = std::env::var("PROJECT_ROOT").unwrap_or_else(|_| ".".to_string());
        format!("{project_root}/dependencies")
    });

    println!("cargo:rustc-link-search=native={ffmpeg_dir}/lib");
    println!("cargo:rustc-link-search=native={deps_dir}/lib");
    println!("cargo:rustc-link-search=native={deps_dir}/lib64");

    // The decoder-only FFmpeg build has no xcb/libX* dependencies — the old
    // library had them because it linked the screen-capture subsystem.

    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=FFMPEG_DIR");
    println!("cargo:rerun-if-env-changed=DEPS_DIR");
}
