//! Windows OLE drag-source implementation. Hand-rolled IDataObject +
//! IDropSource + IEnumFORMATETC + IStream so Explorer / 7-Zip / Total
//! Commander can pull a "virtual file" out of ezTerm.
//!
//! The story end-to-end:
//! 1. The caller spawns a dedicated `std::thread` (the OS message loop
//!    `DoDragDrop` pumps internally is not tokio-compatible — we never
//!    call this from a tokio worker).
//! 2. We `OleInitialize` (APARTMENTTHREADED) on that thread.
//! 3. We construct `FileDescriptorData` (our `IDataObject`) holding
//!    one filename + one byte payload, and `DragSource` (our
//!    `IDropSource`) tracking the mouse state.
//! 4. We call `DoDragDrop`. It blocks. Explorer calls our
//!    `GetData(CFSTR_FILEDESCRIPTORW)` to learn the filename; on drop
//!    it calls `GetData(CFSTR_FILECONTENTS, lindex=0)` and reads bytes
//!    from the returned `IStream`.
//! 5. `DoDragDrop` returns `DRAGDROP_S_DROP` (the user dropped) or
//!    `DRAGDROP_S_CANCEL` (Escape / dropped on void). We translate
//!    both to [`super::DragOutcome`].
//!
//! Phase B1 hard-codes the payload as a `Vec<u8>`. Phase B3 will swap
//! the `MemoryStream` for an `SftpStream` that pulls bytes from a
//! background tokio task via a bounded channel; the IDataObject and
//! IDropSource code below doesn't change.

use std::ffi::OsStr;
use std::mem::ManuallyDrop;
use std::os::windows::ffi::OsStrExt;
use std::sync::Mutex;

use windows::core::{implement, Result as WinResult, PCWSTR};
use windows::Win32::Foundation::{
    BOOL, DATA_S_SAMEFORMATETC, DRAGDROP_S_CANCEL, DRAGDROP_S_DROP, DRAGDROP_S_USEDEFAULTCURSORS,
    DV_E_FORMATETC, DV_E_TYMED, E_NOTIMPL, HGLOBAL, OLE_E_ADVISENOTSUPPORTED, S_FALSE, S_OK,
};
use windows::Win32::System::Com::{
    IAdviseSink, IDataObject, IDataObject_Impl, IEnumFORMATETC, IEnumFORMATETC_Impl,
    IEnumSTATDATA, ISequentialStream_Impl, IStream, IStream_Impl, FORMATETC, LOCKTYPE, STATFLAG,
    STATSTG, STGC, STGMEDIUM, STGMEDIUM_0, STGTY_STREAM, STREAM_SEEK, STREAM_SEEK_CUR,
    STREAM_SEEK_END, STREAM_SEEK_SET, TYMED_HGLOBAL, TYMED_ISTREAM,
};
use windows::Win32::System::DataExchange::RegisterClipboardFormatW;
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
use windows::Win32::System::Ole::{
    DoDragDrop, IDropSource, IDropSource_Impl, OleInitialize, OleUninitialize,
    DROPEFFECT, DROPEFFECT_COPY, DROPEFFECT_NONE,
};
use windows::Win32::System::SystemServices::MODIFIERKEYS_FLAGS;
use windows::Win32::UI::Shell::{FD_FILESIZE, FD_PROGRESSUI, FILEDESCRIPTORW, FILEGROUPDESCRIPTORW};

use crate::error::{AppError, Result};

use super::DragOutcome;

// ===== shell clipboard format registration ================================

/// `CFSTR_FILEDESCRIPTORW` / `CFSTR_FILECONTENTS` are registered at
/// runtime by the shell; the integers come back stable for the
/// process lifetime. We register them lazily and cache.
fn registered_format(name: &[u16]) -> u16 {
    // SAFETY: name is a valid null-terminated UTF-16 buffer.
    let id = unsafe { RegisterClipboardFormatW(PCWSTR(name.as_ptr())) };
    id as u16
}

fn wide(s: &str) -> Vec<u16> {
    OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
}

fn cf_file_descriptor() -> u16 {
    static W: std::sync::OnceLock<Vec<u16>> = std::sync::OnceLock::new();
    registered_format(W.get_or_init(|| wide("FileGroupDescriptorW")))
}

fn cf_file_contents() -> u16 {
    static W: std::sync::OnceLock<Vec<u16>> = std::sync::OnceLock::new();
    registered_format(W.get_or_init(|| wide("FileContents")))
}

// ===== IStream backed by an in-memory Vec<u8> =============================

#[implement(IStream)]
struct MemoryStream {
    inner: Mutex<MemoryStreamState>,
}

struct MemoryStreamState {
    bytes: Vec<u8>,
    pos:   u64,
}

impl MemoryStream {
    fn new(bytes: Vec<u8>) -> IStream {
        let me = MemoryStream { inner: Mutex::new(MemoryStreamState { bytes, pos: 0 }) };
        me.into()
    }
}

#[allow(non_snake_case)]
impl ISequentialStream_Impl for MemoryStream_Impl {
    fn Read(&self, pv: *mut std::ffi::c_void, cb: u32, pcb_read: *mut u32) -> windows::core::HRESULT {
        let mut g = self.inner.lock().unwrap();
        let len = g.bytes.len() as u64;
        let remaining = len.saturating_sub(g.pos);
        let n = (cb as u64).min(remaining) as usize;
        if n > 0 {
            let start = g.pos as usize;
            // SAFETY: caller guarantees pv points to cb bytes of writable memory.
            unsafe {
                std::ptr::copy_nonoverlapping(g.bytes[start..start + n].as_ptr(), pv as *mut u8, n);
            }
            g.pos += n as u64;
        }
        if !pcb_read.is_null() {
            // SAFETY: caller passes a valid u32 out-pointer (or NULL).
            unsafe { *pcb_read = n as u32; }
        }
        S_OK
    }

    fn Write(&self, _pv: *const std::ffi::c_void, _cb: u32, _pcb_written: *mut u32) -> windows::core::HRESULT {
        // Drag-out streams are read-only as far as the OS shell is
        // concerned. E_NOTIMPL is what most reference implementations
        // return for an out-stream that doesn't take writes.
        E_NOTIMPL
    }
}

#[allow(non_snake_case)]
impl IStream_Impl for MemoryStream_Impl {
    fn Seek(&self, dlibmove: i64, dworigin: STREAM_SEEK, plibnewposition: *mut u64) -> WinResult<()> {
        let mut g = self.inner.lock().unwrap();
        let base = match dworigin {
            STREAM_SEEK_SET => 0i64,
            STREAM_SEEK_CUR => g.pos as i64,
            STREAM_SEEK_END => g.bytes.len() as i64,
            _ => return Err(E_NOTIMPL.into()),
        };
        let new_pos = base.saturating_add(dlibmove).max(0) as u64;
        g.pos = new_pos;
        if !plibnewposition.is_null() {
            // SAFETY: caller passes a valid u64 out-pointer (or NULL).
            unsafe { *plibnewposition = new_pos; }
        }
        Ok(())
    }

    fn SetSize(&self, _libnewsize: u64) -> WinResult<()> { Err(E_NOTIMPL.into()) }
    fn CopyTo(&self, _stm: Option<&IStream>, _cb: u64, _pcb_read: *mut u64, _pcb_written: *mut u64) -> WinResult<()> {
        Err(E_NOTIMPL.into())
    }
    fn Commit(&self, _grfcommitflags: &STGC) -> WinResult<()> { Ok(()) }
    fn Revert(&self) -> WinResult<()> { Ok(()) }
    fn LockRegion(&self, _liboffset: u64, _cb: u64, _dwlocktype: &LOCKTYPE) -> WinResult<()> {
        Err(E_NOTIMPL.into())
    }
    fn UnlockRegion(&self, _liboffset: u64, _cb: u64, _dwlocktype: u32) -> WinResult<()> {
        Err(E_NOTIMPL.into())
    }
    fn Stat(&self, pstatstg: *mut STATSTG, _grfstatflag: &STATFLAG) -> WinResult<()> {
        if pstatstg.is_null() { return Err(E_NOTIMPL.into()); }
        let g = self.inner.lock().unwrap();
        let mut s: STATSTG = unsafe { std::mem::zeroed() };
        s.cbSize = g.bytes.len() as u64;
        s.r#type = STGTY_STREAM.0 as u32;
        // SAFETY: caller passes a valid STATSTG out-pointer.
        unsafe { *pstatstg = s; }
        Ok(())
    }
    fn Clone(&self) -> WinResult<IStream> { Err(E_NOTIMPL.into()) }
}

// ===== IDataObject implementation =========================================

#[implement(IDataObject)]
struct FileDescriptorData {
    name:  Vec<u16>, // wide, null-terminated
    bytes: Mutex<Option<Vec<u8>>>,
    cf_descriptor: u16,
    cf_contents:   u16,
}

impl FileDescriptorData {
    fn new(name: &str, bytes: Vec<u8>) -> IDataObject {
        let me = FileDescriptorData {
            name:  wide(name),
            bytes: Mutex::new(Some(bytes)),
            cf_descriptor: cf_file_descriptor(),
            cf_contents:   cf_file_contents(),
        };
        me.into()
    }

    /// Build the FILEGROUPDESCRIPTORW HGLOBAL for our single file.
    fn build_descriptor_hglobal(&self) -> WinResult<HGLOBAL> {
        // FILEGROUPDESCRIPTORW already inlines one FILEDESCRIPTORW
        // (cItems = 1, fgd[0]). Phase B4 will grow this to N descriptors
        // (size = sizeof(FILEGROUPDESCRIPTORW) + (N - 1) * sizeof(FD)).
        let size = std::mem::size_of::<FILEGROUPDESCRIPTORW>();
        // SAFETY: GMEM_MOVEABLE is the canonical flag for HGLOBALs that
        // travel via OLE. GlobalAlloc returns Err on failure.
        let hg = unsafe { GlobalAlloc(GMEM_MOVEABLE, size)? };
        // SAFETY: GlobalLock on a fresh HGLOBAL returns a valid pointer
        // to at least `size` bytes; we zero them, then fill the header
        // and one descriptor.
        unsafe {
            let p = GlobalLock(hg);
            if p.is_null() {
                return Err(E_NOTIMPL.into());
            }
            std::ptr::write_bytes(p as *mut u8, 0, size);
            let header = p as *mut FILEGROUPDESCRIPTORW;
            (*header).cItems = 1;
            let desc = std::ptr::addr_of_mut!((*header).fgd) as *mut FILEDESCRIPTORW;
            let bytes_len = self
                .bytes
                .lock()
                .unwrap()
                .as_ref()
                .map(|b| b.len() as u64)
                .unwrap_or(0);
            (*desc).dwFlags = (FD_FILESIZE.0 | FD_PROGRESSUI.0) as u32;
            (*desc).nFileSizeLow  = (bytes_len & 0xFFFF_FFFF) as u32;
            (*desc).nFileSizeHigh = (bytes_len >> 32) as u32;
            // FILEDESCRIPTORW is packed, so taking a Rust reference to
            // its inner cFileName array is UB even before deref. Get
            // a raw pointer to the array and copy via that.
            let cfilename_ptr = std::ptr::addr_of_mut!((*desc).cFileName) as *mut u16;
            let copy_len = self.name.len().min(260);
            std::ptr::copy_nonoverlapping(
                self.name.as_ptr(),
                cfilename_ptr,
                copy_len,
            );
            let _ = GlobalUnlock(hg);
        }
        Ok(hg)
    }
}

#[allow(non_snake_case)]
impl IDataObject_Impl for FileDescriptorData_Impl {
    fn GetData(&self, pformatetcin: *const FORMATETC) -> WinResult<STGMEDIUM> {
        if pformatetcin.is_null() {
            return Err(DV_E_FORMATETC.into());
        }
        // SAFETY: caller guarantees pformatetcin points to a valid
        // FORMATETC for the duration of the call.
        let fe = unsafe { &*pformatetcin };
        if fe.cfFormat == self.cf_descriptor && fe.tymed & TYMED_HGLOBAL.0 as u32 != 0 {
            let hg = self.build_descriptor_hglobal()?;
            let mut m = STGMEDIUM::default();
            m.tymed = TYMED_HGLOBAL.0 as u32;
            m.u = STGMEDIUM_0 { hGlobal: hg };
            return Ok(m);
        }
        if fe.cfFormat == self.cf_contents && fe.tymed & TYMED_ISTREAM.0 as u32 != 0 {
            // lindex tells us which file's contents to return (we
            // only have one). Anything other than 0 / -1 is an error.
            if fe.lindex > 0 {
                return Err(DV_E_FORMATETC.into());
            }
            let bytes = self.bytes.lock().unwrap().take().unwrap_or_default();
            let stream = MemoryStream::new(bytes);
            let mut m = STGMEDIUM::default();
            m.tymed = TYMED_ISTREAM.0 as u32;
            m.u = STGMEDIUM_0 { pstm: ManuallyDrop::new(Some(stream)) };
            return Ok(m);
        }
        Err(DV_E_FORMATETC.into())
    }

    fn GetDataHere(&self, _pformatetc: *const FORMATETC, _pmedium: *mut STGMEDIUM) -> WinResult<()> {
        Err(E_NOTIMPL.into())
    }

    fn QueryGetData(&self, pformatetc: *const FORMATETC) -> windows::core::HRESULT {
        if pformatetc.is_null() { return DV_E_FORMATETC; }
        let fe = unsafe { &*pformatetc };
        if fe.cfFormat == self.cf_descriptor && fe.tymed & TYMED_HGLOBAL.0 as u32 != 0 { return S_OK; }
        if fe.cfFormat == self.cf_contents && fe.tymed & TYMED_ISTREAM.0 as u32 != 0 { return S_OK; }
        if fe.cfFormat == self.cf_descriptor || fe.cfFormat == self.cf_contents {
            return DV_E_TYMED;
        }
        DV_E_FORMATETC
    }

    fn GetCanonicalFormatEtc(
        &self,
        _pformatect_in: *const FORMATETC,
        pformatetc_out: *mut FORMATETC,
    ) -> windows::core::HRESULT {
        if !pformatetc_out.is_null() {
            unsafe { (*pformatetc_out).ptd = std::ptr::null_mut(); }
        }
        DATA_S_SAMEFORMATETC
    }

    fn SetData(&self, _pformatetc: *const FORMATETC, _pmedium: *const STGMEDIUM, _frelease: BOOL) -> WinResult<()> {
        Err(E_NOTIMPL.into())
    }

    fn EnumFormatEtc(&self, dwdirection: u32) -> WinResult<IEnumFORMATETC> {
        // DATADIR_GET = 1
        if dwdirection != 1 {
            return Err(E_NOTIMPL.into());
        }
        let fmts = vec![
            FORMATETC {
                cfFormat: self.cf_descriptor,
                ptd: std::ptr::null_mut(),
                dwAspect: 1, // DVASPECT_CONTENT
                lindex: -1,
                tymed: TYMED_HGLOBAL.0 as u32,
            },
            FORMATETC {
                cfFormat: self.cf_contents,
                ptd: std::ptr::null_mut(),
                dwAspect: 1,
                lindex: 0,
                tymed: TYMED_ISTREAM.0 as u32,
            },
        ];
        Ok(FormatEnumerator { fmts, idx: Mutex::new(0) }.into())
    }

    fn DAdvise(&self, _pformatetc: *const FORMATETC, _advf: u32, _padv_sink: Option<&IAdviseSink>) -> WinResult<u32> {
        Err(OLE_E_ADVISENOTSUPPORTED.into())
    }
    fn DUnadvise(&self, _dw_connection: u32) -> WinResult<()> {
        Err(OLE_E_ADVISENOTSUPPORTED.into())
    }
    fn EnumDAdvise(&self) -> WinResult<IEnumSTATDATA> {
        Err(OLE_E_ADVISENOTSUPPORTED.into())
    }
}

// ===== IEnumFORMATETC implementation ======================================

#[implement(IEnumFORMATETC)]
struct FormatEnumerator {
    fmts: Vec<FORMATETC>,
    idx:  Mutex<usize>,
}

#[allow(non_snake_case)]
impl IEnumFORMATETC_Impl for FormatEnumerator_Impl {
    fn Next(&self, celt: u32, rgelt: *mut FORMATETC, pcelt_fetched: *mut u32) -> windows::core::HRESULT {
        let mut idx = self.idx.lock().unwrap();
        let mut n = 0usize;
        while n < celt as usize && *idx < self.fmts.len() {
            // SAFETY: caller guarantees rgelt has space for celt entries.
            unsafe { *rgelt.add(n) = self.fmts[*idx]; }
            *idx += 1;
            n += 1;
        }
        if !pcelt_fetched.is_null() {
            unsafe { *pcelt_fetched = n as u32; }
        }
        if n == celt as usize { S_OK } else { S_FALSE }
    }

    fn Skip(&self, celt: u32) -> WinResult<()> {
        let mut idx = self.idx.lock().unwrap();
        let new = *idx + celt as usize;
        if new > self.fmts.len() {
            *idx = self.fmts.len();
            Err(S_FALSE.into())
        } else {
            *idx = new;
            Ok(())
        }
    }

    fn Reset(&self) -> WinResult<()> {
        *self.idx.lock().unwrap() = 0;
        Ok(())
    }

    fn Clone(&self) -> WinResult<IEnumFORMATETC> {
        Ok(FormatEnumerator {
            fmts: self.fmts.clone(),
            idx:  Mutex::new(*self.idx.lock().unwrap()),
        }.into())
    }
}

// ===== IDropSource implementation =========================================

#[implement(IDropSource)]
struct DragSource;

#[allow(non_snake_case)]
impl IDropSource_Impl for DragSource_Impl {
    fn QueryContinueDrag(&self, fescape_pressed: BOOL, grfkeystate: MODIFIERKEYS_FLAGS) -> windows::core::HRESULT {
        // Standard OLE drag semantics:
        //   - Escape ⇒ DRAGDROP_S_CANCEL
        //   - Left button released ⇒ DRAGDROP_S_DROP
        //   - otherwise S_OK (keep dragging)
        const MK_LBUTTON: u32 = 0x0001;
        if fescape_pressed.as_bool() {
            return DRAGDROP_S_CANCEL;
        }
        if grfkeystate.0 & MK_LBUTTON == 0 {
            return DRAGDROP_S_DROP;
        }
        S_OK
    }

    fn GiveFeedback(&self, _dweffect: DROPEFFECT) -> windows::core::HRESULT {
        // Let the OS pick the cursor based on the drop target's accepted
        // effect. We'll customise this in phase B7 to show a download
        // arrow + progress.
        DRAGDROP_S_USEDEFAULTCURSORS
    }
}

// ===== entry point ========================================================

/// Spawn a dedicated thread, OleInitialize it, and call DoDragDrop
/// with our IDataObject + IDropSource. Blocks until the drag finishes.
/// Returns whether the user dropped or cancelled.
pub fn start_file_drag(name: String, bytes: Vec<u8>) -> Result<DragOutcome> {
    let handle = std::thread::spawn(move || -> Result<DragOutcome> {
        // SAFETY: We exclusively own this thread; OleInitialize is the
        // documented entry for COM apartment-threaded use, and
        // OleUninitialize on the same thread balances it.
        unsafe {
            OleInitialize(None)
                .map_err(|e| AppError::Validation(format!("OleInitialize: {e:?}")))?;
        }

        let data: IDataObject = FileDescriptorData::new(&name, bytes);
        let source: IDropSource = DragSource.into();
        let mut effect = DROPEFFECT_NONE;

        let hr = unsafe { DoDragDrop(&data, &source, DROPEFFECT_COPY, &mut effect) };

        unsafe { OleUninitialize(); }

        match hr {
            DRAGDROP_S_DROP => Ok(DragOutcome::Dropped),
            DRAGDROP_S_CANCEL => Ok(DragOutcome::Cancelled),
            other => Err(AppError::Validation(format!("DoDragDrop returned 0x{:08x}", other.0))),
        }
    });

    handle.join().map_err(|_| AppError::Validation("drag thread panicked".into()))?
}
