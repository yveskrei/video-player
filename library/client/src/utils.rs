pub mod registry_api;
pub mod queue;
pub mod logger;

use std::os::raw::{c_char, c_int, c_longlong};

/// Borrow a C array `[ptr; size]` as a slice. Empty if `ptr` is null or
/// `size <= 0`.
///
/// # Safety
/// `ptr` must point to `size` valid, contiguous `T`s that outlive `'a`.
pub unsafe fn get_c_array<'a, T>(ptr: *const T, size: c_int) -> &'a [T] {
    if ptr.is_null() || size <= 0 {
        return &[];
    }
    unsafe {
        std::slice::from_raw_parts(ptr, size as usize)
    }
}

/// Copy a borrowed C string into an owned `String`. None if `ptr` is null or the
/// bytes aren't valid UTF-8. The pointer is borrowed, not freed.
///
/// # Safety
/// `ptr` must be null or point to a valid NUL-terminated C string.
pub unsafe fn read_c_string(ptr: *const c_char) -> Option<String> {
    if ptr.is_null() {
        return None;
    }
    unsafe {
        std::ffi::CStr::from_ptr(ptr)
            .to_str()
            .ok()
            .map(|s| s.to_string())
    }
}

/// `malloc` a NUL-terminated C string the host frees with `FreeCPtr`. Returns
/// null if `s` has an interior NUL or the allocation fails.
pub fn alloc_c_string(s: &str) -> *mut c_char {
    let bytes = s.as_bytes();
    if bytes.contains(&0) {
        return std::ptr::null_mut();
    }
    unsafe {
        let p = libc::malloc(bytes.len() + 1) as *mut u8;
        if p.is_null() {
            return std::ptr::null_mut();
        }
        std::ptr::copy_nonoverlapping(
            bytes.as_ptr(),
            p,
            bytes.len(),
        );
        *p.add(bytes.len()) = 0;
        p as *mut c_char
    }
}

/// `malloc` a `c_longlong` array the host frees with `FreeCPtr`.
pub fn alloc_i64_array(values: &[i64]) -> *mut c_longlong {
    unsafe {
        let p = libc::malloc(std::mem::size_of_val(values)) as *mut c_longlong;
        if !p.is_null() && !values.is_empty() {
            std::ptr::copy_nonoverlapping(
                values.as_ptr(),
                p,
                values.len(),
            );
        }
        p
    }
}

/// `malloc` a pointer array the host frees with `FreeCPtr`.
pub fn alloc_ptr_array(ptrs: &[*const c_char]) -> *mut *const c_char {
    unsafe {
        let p = libc::malloc(std::mem::size_of_val(ptrs)) as *mut *const c_char;
        if !p.is_null() && !ptrs.is_empty() {
            std::ptr::copy_nonoverlapping(
                ptrs.as_ptr(),
                p,
                ptrs.len(),
            );
        }
        p
    }
}
