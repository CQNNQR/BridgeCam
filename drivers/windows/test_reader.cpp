// test_reader.cpp — Automated smoke test for BridgeCam virtual camera.
// Loads BridgeCamFilter.dll directly, creates the COM source, and reads
// frames via IMFSourceReader.  Exit code 0 = success.
//
// Build: cmake --build build --config Debug --target test_reader

#include <windows.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <mferror.h>
#include <stdio.h>
#include <string.h>

#pragma comment(lib, "mfplat.lib")
#pragma comment(lib, "mfreadwrite.lib")
#pragma comment(lib, "mf.lib")
#pragma comment(lib, "mfuuid.lib")
#pragma comment(lib, "ole32.lib")

// Our CLSID — must match BridgeCamMFSource.cpp
const GUID CLSID_BridgeCamMFSource = {
    0xb9eaafe1, 0x1234, 0x5678,
    { 0xab, 0xcd, 0x12, 0x34, 0x56, 0x78, 0x90, 0xab }
};

typedef HRESULT (STDAPICALLTYPE *FnDllGetClassObject)(REFCLSID, REFIID, void**);

static void PrintHR(const char* label, HRESULT hr) {
    printf("  %-44s 0x%08lX %s\n", label, (unsigned long)hr,
           SUCCEEDED(hr) ? "OK" : "FAIL");
}

int main()
{
    printf("=== BridgeCam Smoke Test (direct DLL load) ===\n\n");

    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(hr)) { printf("CoInitializeEx failed 0x%08lX\n", (unsigned long)hr); return 1; }
    hr = MFStartup(MF_VERSION);
    if (FAILED(hr)) { printf("MFStartup failed 0x%08lX\n", (unsigned long)hr); CoUninitialize(); return 1; }

    // ── Step 1: Load DLL ──
    printf("[1] Loading BridgeCamFilter.dll...\n");
    const char* dllPath = "C:\\ProgramData\\BridgeCam\\BridgeCamFilter.dll";
    HMODULE hDll = LoadLibraryA(dllPath);
    if (!hDll) {
        printf("  FAIL: LoadLibrary error %lu\n", GetLastError());
        return 1;
    }
    printf("  Loaded: %s\n", dllPath);

    FnDllGetClassObject pDllGetClassObject =
        (FnDllGetClassObject)GetProcAddress(hDll, "DllGetClassObject");
    if (!pDllGetClassObject) {
        printf("  FAIL: DllGetClassObject not exported\n");
        return 1;
    }
    printf("  DllGetClassObject found\n");

    // ── Step 2: Create class factory → activate ──
    printf("\n[2] Creating COM objects...\n");
    IClassFactory* pFactory = nullptr;
    hr = pDllGetClassObject(CLSID_BridgeCamMFSource, IID_IClassFactory, (void**)&pFactory);
    PrintHR("DllGetClassObject(IClassFactory)", hr);
    if (FAILED(hr)) return 2;

    IMFActivate* pActivate = nullptr;
    hr = pFactory->CreateInstance(nullptr, IID_IMFActivate, (void**)&pActivate);
    PrintHR("CreateInstance(IMFActivate)", hr);
    pFactory->Release();
    if (FAILED(hr)) return 2;

    // ── Step 3: First ActivateObject (simulates enumeration) ──
    printf("\n[3] Simulating Frame Server enumeration cycle...\n");
    IMFMediaSource* pSource1 = nullptr;
    hr = pActivate->ActivateObject(__uuidof(IMFMediaSource), (void**)&pSource1);
    PrintHR("ActivateObject #1 (enum)", hr);
    if (FAILED(hr)) return 3;

    // Query PD to simulate Frame Server inspection
    IMFPresentationDescriptor* pPD = nullptr;
    hr = pSource1->CreatePresentationDescriptor(&pPD);
    PrintHR("CreatePresentationDescriptor", hr);
    if (pPD) {
        DWORD sdCount = 0;
        pPD->GetStreamDescriptorCount(&sdCount);
        printf("  Stream count: %lu\n", sdCount);
        pPD->Release();
    }

    // Shutdown source (Frame Server does this after enumeration)
    hr = pSource1->Shutdown();
    PrintHR("Shutdown (after enum)", hr);
    pSource1->Release();
    pSource1 = nullptr;
    printf("  Enumeration cycle complete — source dead\n");

    // ── Step 4: Second ActivateObject (simulates actual capture) ──
    printf("\n[4] Second ActivateObject (capture)...\n");
    IMFMediaSource* pSource2 = nullptr;
    hr = pActivate->ActivateObject(__uuidof(IMFMediaSource), (void**)&pSource2);
    PrintHR("ActivateObject #2 (capture)", hr);
    if (FAILED(hr)) {
        printf("  CRITICAL: Second ActivateObject FAILED — dead source reuse bug!\n");
        pActivate->Release();
        return 3;
    }

    // ── Step 5: Create Source Reader ──
    printf("\n[5] Creating IMFSourceReader...\n");
    IMFAttributes* pReaderAttr = nullptr;
    MFCreateAttributes(&pReaderAttr, 2);
    pReaderAttr->SetUINT32(MF_LOW_LATENCY, TRUE);
    // Enable the source reader's video processing pipeline so it can decode
    pReaderAttr->SetUINT32(MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, TRUE);

    IMFSourceReader* pReader = nullptr;
    hr = MFCreateSourceReaderFromMediaSource(pSource2, pReaderAttr, &pReader);
    PrintHR("MFCreateSourceReaderFromMediaSource", hr);
    if (pReaderAttr) pReaderAttr->Release();
    if (FAILED(hr)) {
        printf("  Cannot create source reader\n");
        pSource2->Release(); pActivate->Release();
        return 3;
    }

    // ── Step 6: Check current media type ──
    printf("\n[6] Checking media type...\n");
    IMFMediaType* pType = nullptr;
    hr = pReader->GetCurrentMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM, &pType);
    PrintHR("GetCurrentMediaType", hr);
    if (SUCCEEDED(hr) && pType) {
        GUID subtype = {};
        pType->GetGUID(MF_MT_SUBTYPE, &subtype);
        UINT32 w = 0, h = 0;
        MFGetAttributeSize(pType, MF_MT_FRAME_SIZE, &w, &h);
        const BYTE* sg = reinterpret_cast<const BYTE*>(&subtype);
        printf("  Subtype: %02X%02X%02X%02X  Size: %ux%u\n",
               sg[0], sg[1], sg[2], sg[3], w, h);
        pType->Release();
    }

    // Request RGB32 output for easy pixel inspection
    IMFMediaType* pOutType = nullptr;
    MFCreateMediaType(&pOutType);
    pOutType->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
    pOutType->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_RGB32);
    hr = pReader->SetCurrentMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM, nullptr, pOutType);
    PrintHR("SetCurrentMediaType(RGB32)", hr);
    pOutType->Release();

    // ── Step 7: Read frames ──
    printf("\n[7] Reading frames...\n");
    int framesRead = 0;
    int nonBlackFrames = 0;

    for (int attempt = 0; attempt < 5; attempt++) {
        DWORD streamIndex = 0, flags = 0;
        LONGLONG timestamp = 0;
        IMFSample* pSample = nullptr;

        hr = pReader->ReadSample(MF_SOURCE_READER_FIRST_VIDEO_STREAM,
                                 0, &streamIndex, &flags, &timestamp, &pSample);
        printf("  Frame %d: hr=0x%08lX flags=0x%lX sample=%s",
               attempt + 1, (unsigned long)hr, (unsigned long)flags,
               pSample ? "YES" : "NULL");

        if (FAILED(hr)) { printf(" (ReadSample failed)\n"); continue; }
        if (flags & MF_SOURCE_READERF_ENDOFSTREAM) { printf(" (EOS)\n"); break; }
        if (!pSample) { printf("\n"); continue; }

        framesRead++;

        // Inspect pixel data
        IMFMediaBuffer* pBuf = nullptr;
        pSample->ConvertToContiguousBuffer(&pBuf);
        if (pBuf) {
            BYTE* pData = nullptr; DWORD curLen = 0;
            pBuf->Lock(&pData, nullptr, &curLen);
            if (pData && curLen > 0) {
                // Check several points (RGB32: B,G,R,A)
                bool allBlack = true;
                DWORD pixelCount = curLen / 4;
                DWORD checks[] = {0, pixelCount/4, pixelCount/2, pixelCount*3/4};
                for (int c = 0; c < 4; c++) {
                    DWORD off = checks[c] * 4;
                    if (off + 3 < curLen) {
                        BYTE b = pData[off], g = pData[off+1], r = pData[off+2];
                        if (r > 5 || g > 5 || b > 5) allBlack = false;
                    }
                }
                if (!allBlack) {
                    nonBlackFrames++;
                    BYTE b=pData[0], g=pData[1], r=pData[2];
                    printf(" %lu bytes  pixel[0] R=%u G=%u B=%u  NON-BLACK\n",
                           (unsigned long)curLen, r, g, b);
                } else {
                    printf(" %lu bytes  BLACK\n", (unsigned long)curLen);
                }
                pBuf->Unlock();
            }
            pBuf->Release();
        }
        pSample->Release();
        Sleep(100);
    }

    // ── Step 8: Results ──
    printf("\n[8] Summary\n");
    printf("  Frames read:      %d / 5\n", framesRead);
    printf("  Non-black frames: %d\n", nonBlackFrames);

    pReader->Release();
    pSource2->Shutdown();
    pSource2->Release();
    pActivate->Release();
    MFShutdown();
    CoUninitialize();
    FreeLibrary(hDll);

    if (nonBlackFrames > 0) {
        printf("\nRESULT: PASS (got %d non-black frame(s))\n", nonBlackFrames);
        return 0;
    } else if (framesRead > 0) {
        printf("\nRESULT: FAIL (frames received but all black)\n");
        return 4;
    } else {
        printf("\nRESULT: FAIL (no frames received)\n");
        return 5;
    }
}
