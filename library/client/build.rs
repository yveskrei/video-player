// Wires the statically-built (decoder-only) FFmpeg into the rustc link line and
// hides its symbols from the shipped .so.
//
// build_library.sh exports FFMPEG_DIR and the static-link RUSTFLAGS; this file
// registers the native search paths and the symbol-hiding link arg.
//
// Symbol export: rustc already generates a version-script for the cdylib that
// exports only the `#[no_mangle] pub extern "C"` functions in src/api.rs and
// hides everything else — so we do NOT pass our own version-script (a second one
// conflicts with rustc's: "anonymous version tag cannot be combined with other
// version tags"). We only add --exclude-libs,ALL to also hide the statically
// linked FFmpeg `av*` archive symbols. version-script.map documents the exported
// ABI; it is not passed to the linker.

fn main() {
    // Production build: build_library.sh exports FFMPEG_DIR for the static,
    // symbol-hidden, shippable .so. Developer build: with FFMPEG_DIR unset we
    // fall back to a plain link against the system FFmpeg that `ffmpeg-sys-next`
    // already discovers via pkg-config — no static wiring, no symbol hiding
    // (those only matter for the distributed artifact).
    match std::env::var("FFMPEG_DIR") {
        Ok(ffmpeg_dir) => {
            // Native library search paths (lib and lib64 for distro variance).
            println!("cargo:rustc-link-search=native={ffmpeg_dir}/lib");
            println!("cargo:rustc-link-search=native={ffmpeg_dir}/lib64");

            // Hide the statically-linked FFmpeg (av*) archive symbols so our .so
            // can't clash with a host that loads its own FFmpeg. rustc's own
            // cdylib version-script already limits the exports to our C ABI.
            println!("cargo:rustc-link-arg=-Wl,--exclude-libs,ALL");
        }
        Err(_) => {
            println!(
                "cargo:warning=FFMPEG_DIR not set — developer build against the system FFmpeg \
                 (pkg-config). Use ./build_library.sh for the static, symbol-hidden release .so."
            );
        }
    }

    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=FFMPEG_DIR");
    // Rebuild when the cooked-in backend config changes (env! bakes these in).
    println!("cargo:rerun-if-env-changed=B2B_URL");
}
