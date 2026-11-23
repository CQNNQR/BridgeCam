// test_vcam.cpp
// Standalone test: calls MFCreateVirtualCamera + Start() and prints the
// exact HRESULT so we know why BridgeCam isn't appearing in NVB.
// Build: cmake --build build --config Debug --target test_vcam
// Run:   .\build\Debug\test_vcam.exe

#include <windows.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mfvirtualcamera.h>  // MFCreateVirtualCamera, MFVirtualCamera*
#include <mfreadwrite.h>      // MFCreateSourceReaderFromMediaSource
#include <stdio.h>

#pragma comment(lib, "mfsensorgroup.lib")
#pragma comment(lib, "mfplat.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "mfreadwrite.lib")

// CLSID_BridgeCamMFSource = {B9EAAFE1-1234-5678-ABCD-1234567890AB}
// Passed as the sourceid string to MFCreateVirtualCamera.
static const wchar_t* kSourceId       = L"{B9EAAFE1-1234-5678-ABCD-1234567890AB}";
static const wchar_t* kFriendlyName   = L"BridgeCam Source";

int main(int argc, char* argv[])
{
    bool publishOnly = false;
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--publish-only") == 0) {
            publishOnly = true;
        }
    }

    HRESULT hr = CoInitializeEx(NULL, COINIT_MULTITHREADED);
    if (FAILED(hr)) { printf("CoInitializeEx failed: 0x%08lX\n", hr); return 1; }

    hr = MFStartup(MF_VERSION);
    if (FAILED(hr)) { printf("MFStartup failed: 0x%08lX\n", hr); return 1; }

    printf("Calling MFCreateVirtualCamera...\n");

    IMFVirtualCamera* pVCam = NULL;
    hr = MFCreateVirtualCamera(
        MFVirtualCameraType_SoftwareCameraSource,
        MFVirtualCameraLifetime_Session,
        MFVirtualCameraAccess_CurrentUser,
        kFriendlyName,
        kSourceId,
        NULL,   // no extra categories
        0,
        &pVCam
    );
    printf("MFCreateVirtualCamera: 0x%08lX %s\n", hr, SUCCEEDED(hr) ? "OK" : "FAILED");
    if (FAILED(hr)) goto done;

    printf("Calling Start()...\n");
    hr = pVCam->Start(NULL);
    printf("Start():               0x%08lX %s\n", hr, SUCCEEDED(hr) ? "OK" : "FAILED");

    if (SUCCEEDED(hr)) {
        printf("\nVirtual camera is published.\n");
        if (publishOnly) {
            printf("\nVirtual camera is published (publish-only mode). sleeping indefinitely...\n");
            // simply sleep forever instead of waiting on stdin, since background
            // terminals close stdin.  the user can kill the process manually.
            while (true) { Sleep(10000); }
        } else {
            printf("Opening enum_mf_devices in 2s...\n");
        Sleep(2000);

        // Re-enumerate to confirm
        IMFAttributes* pAttr = NULL;
        MFCreateAttributes(&pAttr, 1);
        pAttr->SetGUID(MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE,
                       MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID);
        IMFActivate** ppDevices = NULL; UINT32 count = 0;
        if (SUCCEEDED(MFEnumDeviceSources(pAttr, &ppDevices, &count))) {
            printf("MFEnumDeviceSources found %u device(s):\n", count);
            for (UINT32 i = 0; i < count; i++) {
                WCHAR* name = NULL; UINT32 len = 0;
                ppDevices[i]->GetAllocatedString(MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME, &name, &len);
                wprintf(L"  [%u] %s\n", i, name ? name : L"(null)");
                if (name) CoTaskMemFree(name);
                ppDevices[i]->Release();
            }
            CoTaskMemFree(ppDevices);
        }
        pAttr->Release();

        // after enumeration, also try opening a reader to pull a single frame
        printf("\nAttempting to open source reader to grab one sample...\n");
        IMFAttributes* pAttr2 = nullptr;
        MFCreateAttributes(&pAttr2, 1);
        pAttr2->SetGUID(MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE, MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID);
        IMFActivate** ppAct = nullptr;
        UINT32 cnt = 0;
        if (SUCCEEDED(MFEnumDeviceSources(pAttr2, &ppAct, &cnt)) && cnt > 0 && ppAct) {
            // find our device by name containing "BridgeCam" (friendly text may include extra)
            IMFActivate* chosen = nullptr;
            for (UINT32 i = 0; i < cnt; i++) {
                WCHAR* name = nullptr; UINT32 len = 0;
                ppAct[i]->GetAllocatedString(MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME, &name, &len);
                if (name && wcsstr(name, L"BridgeCam")) {
                    chosen = ppAct[i];
                }
                if (name) CoTaskMemFree(name);
            }
            if (chosen) {
                chosen->AddRef();
                IMFMediaSource* pSrc = nullptr;
                chosen->ActivateObject(IID_PPV_ARGS(&pSrc));
                IMFSourceReader* pReader = nullptr;
                MFCreateSourceReaderFromMediaSource(pSrc, nullptr, &pReader);
                printf("SourceReader created, reading sample...\n");
                DWORD streamIndex, flags;
                LONGLONG llTime;
                IMFSample* pSample = nullptr;
                HRESULT hr2 = pReader->ReadSample(
                    MF_SOURCE_READER_FIRST_VIDEO_STREAM,
                    0, &streamIndex, &flags, &llTime, &pSample);
                printf("ReadSample returned 0x%08lX, flags=0x%X\n", hr2, flags);
                if (pSample) { pSample->Release(); }
                pReader->Release();
                pSrc->Release();
                chosen->Release();
            } else {
                printf("Could not locate BridgeCam activate object\n");
            }
            // release the activate array
            for (UINT32 i = 0; i < cnt; i++) ppAct[i]->Release();
            CoTaskMemFree(ppAct);
        }
        if (pAttr2) pAttr2->Release();

        printf("\nPress Enter to remove the virtual camera...\n");
        getchar();
        }
        
        pVCam->Stop();
        pVCam->Remove();
    }

    pVCam->Release();
done:
    MFShutdown();
    CoUninitialize();
    return FAILED(hr) ? 1 : 0;
}
