// enum_mf_devices.cpp
// Lists all Media Foundation video capture devices — the same list that NVIDIA
// Broadcast, Teams, Zoom, etc. see.  Run while the Tauri app has the virtual
// camera activated to check if BridgeCam appears.
//
// Build:  cl /EHsc enum_mf_devices.cpp /link mf.lib mfplat.lib ole32.lib
//    or via CMake (added to CMakeLists.txt).

#include <windows.h>
#include <mfapi.h>
#include <mfidl.h>
#include <stdio.h>

#pragma comment(lib, "mf.lib")
#pragma comment(lib, "mfplat.lib")
#pragma comment(lib, "ole32.lib")

int main()
{
    CoInitializeEx(NULL, COINIT_MULTITHREADED);
    MFStartup(MF_VERSION);

    IMFAttributes* pAttr = NULL;
    MFCreateAttributes(&pAttr, 1);
    pAttr->SetGUID(MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE,
                   MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID);

    IMFActivate** ppDevices = NULL;
    UINT32 count = 0;
    HRESULT hr = MFEnumDeviceSources(pAttr, &ppDevices, &count);
    if (FAILED(hr)) {
        printf("MFEnumDeviceSources failed: 0x%08lX\n", hr);
        pAttr->Release();
        MFShutdown();
        CoUninitialize();
        return 1;
    }

    printf("=== Media Foundation Video Capture Devices (%u) ===\n", count);
    for (UINT32 i = 0; i < count; i++) {
        WCHAR* name = NULL;
        UINT32 nameLen = 0;
        ppDevices[i]->GetAllocatedString(MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME,
                                          &name, &nameLen);

        WCHAR* symLink = NULL;
        UINT32 symLen = 0;
        ppDevices[i]->GetAllocatedString(
            MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK,
            &symLink, &symLen);

        wprintf(L"[%u] %s\n    symlink: %s\n", i, name ? name : L"(null)",
                symLink ? symLink : L"(null)");

        if (name) CoTaskMemFree(name);
        if (symLink) CoTaskMemFree(symLink);
        ppDevices[i]->Release();
    }
    CoTaskMemFree(ppDevices);

    if (count == 0) printf("(no devices found)\n");

    pAttr->Release();
    MFShutdown();
    CoUninitialize();
    return 0;
}
