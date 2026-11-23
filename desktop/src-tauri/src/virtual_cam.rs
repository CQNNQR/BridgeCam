// BridgeCam Virtual Camera Module
// IMFVirtualCamera management

use std::sync::Mutex;
use windows::{
    core::HSTRING,
    Win32::Media::MediaFoundation::{
        IMFVirtualCamera, MFCreateVirtualCamera,
        MFVirtualCameraAccess, MFVirtualCameraLifetime, MFVirtualCameraType,
    },
};

// COM source registered by drivers/windows/BridgeCamMFSource.cpp.
const SOURCE_CLSID: &str = "{B9EAAFE1-1234-5678-ABCD-1234567890AB}";

struct SendVCam(IMFVirtualCamera);
unsafe impl Send for SendVCam {}

static VIRTUAL_CAM: Mutex<Option<SendVCam>> = Mutex::new(None);

pub fn activate() -> Result<String, String> {
    let mut guard = VIRTUAL_CAM.lock().unwrap();
    if guard.is_some() {
        return Ok("already active".to_string());
    }

    let friendly = HSTRING::from("BridgeCam Source");
    let source_id = HSTRING::from(SOURCE_CLSID);

    let vcam = unsafe {
        MFCreateVirtualCamera(
            MFVirtualCameraType(0),
            MFVirtualCameraLifetime(0),
            MFVirtualCameraAccess(0),
            &friendly,
            &source_id,
            None,
        )
    }
    .map_err(|e| format!("MFCreateVirtualCamera failed: {e:?}"))?;

    let start_result = unsafe { vcam.Start(None) };
    let start_msg = match &start_result {
        Ok(_) => "Start() OK".to_string(),
        Err(e) => return Err(format!("IMFVirtualCamera::Start() failed: {e:?}")),
    };

    *guard = Some(SendVCam(vcam));
    Ok(start_msg)
}

pub fn deactivate() -> Result<(), String> {
    let mut guard = VIRTUAL_CAM.lock().unwrap();
    if let Some(SendVCam(cam)) = guard.take() {
        let _ = unsafe { cam.Stop() };
        let _ = unsafe { cam.Remove() };
    }
    Ok(())
}
