// test_vcam_external.cpp
// Consumer-only test for BridgeCam virtual camera.
// Does NOT call MFCreateVirtualCamera.  Instead it enumerates video
// capture devices, locates the BridgeCam Source, then activates it and
// pulls a single sample via IMFSourceReader.
// Use this to verify that an external process (like NVB) actually triggers
// our COM source's Start() method.
// Build: cmake --build build --config Debug --target test_vcam_external
// Run:   .\build\Debug\test_vcam_external.exe

#include <windows.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <stdio.h>

#pragma comment(lib, "mfsensorgroup.lib")
#pragma comment(lib, "mfplat.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "mfreadwrite.lib")

int main()
{
    printf("test_vcam_external PID=%lu\n", GetCurrentProcessId());
    HRESULT hr = CoInitializeEx(NULL, COINIT_MULTITHREADED);
    if (FAILED(hr)) { printf("CoInitializeEx failed: 0x%08lX\n", hr); return 1; }

    hr = MFStartup(MF_VERSION);
    if (FAILED(hr)) { printf("MFStartup failed: 0x%08lX\n", hr); return 1; }

    IMFAttributes* pAttr = nullptr;
    MFCreateAttributes(&pAttr, 1);
    pAttr->SetGUID(MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE,
                   MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID);
    IMFActivate** ppAct = nullptr;
    UINT32 cnt = 0;
    hr = MFEnumDeviceSources(pAttr, &ppAct, &cnt);
    if (FAILED(hr)) {
        printf("MFEnumDeviceSources failed: 0x%08lX\n", hr);
        return 1;
    }

    printf("Found %u capture devices:\n", cnt);
    for (UINT32 i = 0; i < cnt; i++) {
        WCHAR* name = nullptr; UINT32 len = 0;
        ppAct[i]->GetAllocatedString(MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME, &name, &len);
        wprintf(L"  [%u] %s\n", i, name ? name : L"(null)");
        if (name) CoTaskMemFree(name);
    }

    // pick our BridgeCam device by substring
    IMFActivate* chosen = nullptr;
    for (UINT32 i = 0; i < cnt; i++) {
        WCHAR* name = nullptr; UINT32 len = 0;
        ppAct[i]->GetAllocatedString(MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME, &name, &len);
        if (name && wcsstr(name, L"BridgeCam")) {
            chosen = ppAct[i];
        }
        if (name) CoTaskMemFree(name);
    }

    if (!chosen) {
        printf("BridgeCam device not present\n");
    } else {
        chosen->AddRef();
        IMFMediaSource* pSrc = nullptr;
        HRESULT hrAct = chosen->ActivateObject(IID_PPV_ARGS(&pSrc));
        printf("ActivateObject returned 0x%08lX\n", hrAct);
        if (SUCCEEDED(hrAct) && pSrc) {
            printf("Activated device. Calling Start() as consumer...\n");
            HRESULT hrStart = pSrc->Start(NULL, nullptr, nullptr);
            printf("Consumer Start(): 0x%08lX\n", hrStart);
        } else {
            printf("Failed to get media source, skipping Start\n");
        }
        printf("Creating reader...\n");
        IMFSourceReader* pReader = nullptr;
        MFCreateSourceReaderFromMediaSource(pSrc, nullptr, &pReader);
        if (!pReader) {
            printf("Failed to create source reader\n");
        } else {
            // enumerate and display native media types
            IMFMediaType* firstType = nullptr;
            for (DWORD i = 0; ; i++) {
                IMFMediaType* pType = nullptr;
                HRESULT hri = pReader->GetNativeMediaType(
                    MF_SOURCE_READER_FIRST_VIDEO_STREAM, i, &pType);
                if (FAILED(hri)) break;
                GUID major, sub;
                pType->GetGUID(MF_MT_MAJOR_TYPE, &major);
                pType->GetGUID(MF_MT_SUBTYPE, &sub);
                wchar_t maj[40], subn[40];
                StringFromGUID2(major, maj, 40);
                StringFromGUID2(sub,  subn, 40);
                wprintf(L"Native type %u: %ls / %ls\n", i, maj, subn);
                if (!firstType) firstType = pType;
                else pType->Release();
            }
            if (firstType) {
                printf("Setting current media type to first native type\n");
                pReader->SetCurrentMediaType(
                    MF_SOURCE_READER_FIRST_VIDEO_STREAM, nullptr, firstType);
                firstType->Release();
            }
            pReader->SetStreamSelection(MF_SOURCE_READER_FIRST_VIDEO_STREAM, TRUE);

            printf("Reader created and configured, calling ReadSample\n");
            DWORD streamIndex, flags;
            LONGLONG llTime;
            IMFSample* pSample = nullptr;
            HRESULT hr2 = pReader->ReadSample(
                MF_SOURCE_READER_FIRST_VIDEO_STREAM,
                0, &streamIndex, &flags, &llTime, &pSample);
            printf("ReadSample returned 0x%08lX flags=0x%X\n", hr2, flags);
            if (pSample) { pSample->Release(); }
            pReader->Release();
        }
        pSrc->Release();
        chosen->Release();
    }

    for (UINT32 i = 0; i < cnt; i++) ppAct[i]->Release();
    CoTaskMemFree(ppAct);
    pAttr->Release();

    MFShutdown();
    CoUninitialize();
    return 0;
}
