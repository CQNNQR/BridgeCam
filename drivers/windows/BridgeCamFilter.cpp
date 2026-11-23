// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 BridgeCam Contributors
//
// BridgeCamFilter.cpp
// DirectShow push-source filter that exposes a virtual webcam fed from the
// shared-memory file written by the Tauri desktop app.

#include <windows.h>
#include <dshow.h>
#include <strmif.h>
#include <windows.h>
#include <cstdio>

// simple debug logger for the filter (Debug builds only)
static void FilterLog(const char* msg)
{
#ifdef _DEBUG
    char path[MAX_PATH];
    if (GetEnvironmentVariableA("TEMP", path, MAX_PATH) > 0) {
        strcat_s(path, "\\bridgecam_filter.log");
        HANDLE hf = CreateFileA(path, GENERIC_WRITE, FILE_SHARE_READ|FILE_SHARE_WRITE,
                                nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
        if (hf != INVALID_HANDLE_VALUE) {
            SetFilePointer(hf, 0, nullptr, FILE_END);
            DWORD written; WriteFile(hf, msg, (DWORD)strlen(msg), &written, nullptr);
            CloseHandle(hf);
        }
    }
#else
    (void)msg;
#endif
}

// module instance stored by DllMain; non-static so BridgeCamMFSource.cpp can reference it
HINSTANCE g_hInst = NULL;

// Forward declarations from BridgeCamMFSource.cpp
HRESULT RegisterMFSource();
HRESULT UnregisterMFSource();
STDAPI  BridgeCamMF_GetClassObject(REFCLSID, REFIID, void**);

// helper routines for registry modifications
static HRESULT SetRegKeyValue(HKEY hRoot, LPCWSTR subKey, LPCWSTR valueName, LPCWSTR data)
{
    HKEY hKey;
    DWORD disposition;
    LONG res = RegCreateKeyExW(hRoot, subKey, 0, NULL, REG_OPTION_NON_VOLATILE,
                               KEY_WRITE, NULL, &hKey, &disposition);
    if (res != ERROR_SUCCESS) return HRESULT_FROM_WIN32(res);
    res = RegSetValueExW(hKey, valueName, 0, REG_SZ,
                         (const BYTE*)data,
                         (DWORD)((wcslen(data)+1) * sizeof(wchar_t)));
    RegCloseKey(hKey);
    return HRESULT_FROM_WIN32(res);
}

static HRESULT DeleteRegKeyTree(HKEY hRoot, LPCWSTR subKey)
{
    // RegDeleteTreeW is available on Vista+ and removes a key and all
    // its descendants.
    LONG res = RegDeleteTreeW(hRoot, subKey);
    if (res == ERROR_SUCCESS || res == ERROR_FILE_NOT_FOUND)
        return S_OK;
    return HRESULT_FROM_WIN32(res);
}

// GUID strings
static const wchar_t *kFilterClsidStr = L"{B9EAAFE0-1234-5678-ABCD-1234567890AB}";
static const wchar_t *kFilterFriendlyName = L"BridgeCam Source";
static const wchar_t *kVideoInputCategory = L"{860BB310-5D01-11D0-BD3B-00A0C911CE86}";


// ---------------------------------------------------------------------------
// Minimal stub base classes
// ---------------------------------------------------------------------------

#ifndef NAME
#define NAME(x) x
#endif

#ifndef _CUNKNOWN_DEFINED
class CUnknown {
public:
    virtual ~CUnknown() {}
};
#define _CUNKNOWN_DEFINED
#endif

// Forward-declare the source class so CBridgeCamStream can reference it.
class CBridgeCamSource;

#ifndef _CSOURCESTREAM_DEFINED
class CSourceStream : public CUnknown {
public:
    CSourceStream(const char* /*name*/, HRESULT* /*phr*/,
                  CBridgeCamSource* /*parent*/, LPCWSTR /*pinName*/) {}
    // Use __stdcall so 32-bit overrides match the calling convention
    virtual HRESULT __stdcall GetMediaType(int, AM_MEDIA_TYPE*) { return E_NOTIMPL; }
    virtual HRESULT __stdcall DecideBufferSize(IMemAllocator*, ALLOCATOR_PROPERTIES*) { return E_NOTIMPL; }
    virtual HRESULT __stdcall FillBuffer(IMediaSample*) { return E_NOTIMPL; }
};
#define _CSOURCESTREAM_DEFINED
#endif

#ifndef _CSOURCE_DEFINED
class CSource : public CUnknown {
public:
    CSource(const char* /*name*/, LPUNKNOWN /*pUnk*/,
            const CLSID& /*clsid*/, HRESULT* /*pHr*/) {}
};
#define _CSOURCE_DEFINED
#endif


// {B9EAAFE0-1234-5678-ABCD-1234567890AB}
DEFINE_GUID(CLSID_BridgeCamSource,
0xb9eaafe0,0x1234,0x5678,0xab,0xcd,0x12,0x34,0x56,0x78,0x90,0xab);

// Named Win32 shared memory produced by the Tauri desktop app.
// Layout: [DWORD width][DWORD height][DWORD frame_seq][RGBA bytes...]
// Use a GLOBAL mapping so the Frame Server (session 0) can open it
static const char kNamedMapping[] = "Global\\BridgeCamFrameBuffer";
static const DWORD kHeaderSize    = 12; // 3 × 4 bytes

// ---------------------------------------------------------------------------
// CBridgeCamStream
// ---------------------------------------------------------------------------
class CBridgeCamStream : public CSourceStream
{
public:
    CBridgeCamStream(HRESULT *phr, CBridgeCamSource *pParent, LPCWSTR pPinName)
      : CSourceStream(NAME("BridgeCam Stream"), phr, pParent, pPinName),
        m_iWidth(1280),
        m_iHeight(720),
        m_hNamedMap(NULL),
        m_pNamedView(NULL)
    {
        // Try to read initial dimensions from the named mapping or env vars.
        ensureNamedMapping();
        updateDimensions();
    }

    ~CBridgeCamStream()
    {
        closeNamedMapping();
    }

    STDMETHODIMP GetMediaType(int iPosition, AM_MEDIA_TYPE *pmt)
    {
        if (iPosition < 0) return E_INVALIDARG;
        if (iPosition > 0) return VFW_S_NO_MORE_ITEMS;

        // Refresh dimensions from the shared memory header before the graph connects.
        ensureNamedMapping();
        updateDimensions();

        VIDEOINFOHEADER *pvi = (VIDEOINFOHEADER*)CoTaskMemAlloc(sizeof(VIDEOINFOHEADER));
        if (!pvi) return E_OUTOFMEMORY;
        ZeroMemory(pvi, sizeof(VIDEOINFOHEADER));

        pvi->AvgTimePerFrame = 333333; // 30 fps in 100-ns units

        BITMAPINFOHEADER &bih = pvi->bmiHeader;
        bih.biSize        = sizeof(BITMAPINFOHEADER);
        bih.biWidth       = m_iWidth;
        bih.biHeight      = -(m_iHeight); // negative = top-down rows (matches canvas output)
        bih.biPlanes      = 1;
        bih.biBitCount    = 32;
        bih.biCompression = BI_RGB;
        bih.biSizeImage   = m_iWidth * m_iHeight * 4;

        pmt->majortype            = MEDIATYPE_Video;
        pmt->subtype              = MEDIASUBTYPE_RGB32;
        pmt->formattype           = FORMAT_VideoInfo;
        pmt->bFixedSizeSamples    = TRUE;
        pmt->bTemporalCompression = FALSE;
        pmt->lSampleSize          = m_iWidth * m_iHeight * 4;
        pmt->cbFormat             = sizeof(VIDEOINFOHEADER);
        pmt->pbFormat             = (BYTE*)pvi;

        return S_OK;
    }

    STDMETHODIMP DecideBufferSize(IMemAllocator *pAlloc, ALLOCATOR_PROPERTIES *pProp)
    {
        if (!pAlloc || !pProp) return E_POINTER;
        pProp->cBuffers = 2;
        pProp->cbBuffer = m_iWidth * m_iHeight * 4;
        ALLOCATOR_PROPERTIES actual;
        return pAlloc->SetProperties(pProp, &actual);
    }

    STDMETHODIMP FillBuffer(IMediaSample *pSample)
    {
        if (!pSample) return E_POINTER;

        // Pace at ~30 fps so we don't spin the downstream renderer.
        Sleep(30);

        BYTE *pBuffer = nullptr;
        HRESULT hr = pSample->GetPointer(&pBuffer);
        if (FAILED(hr)) return hr;
        // log that FillBuffer was invoked
        FilterLog("FillBuffer called\r\n");

        // Try named Win32 mapping first — works for any process without env vars.
        ensureNamedMapping();
        if (m_pNamedView) {
            const DWORD *hdr = static_cast<const DWORD*>(m_pNamedView);
            DWORD w = hdr[0], h = hdr[1];
            if (w > 0 && h > 0) {
                // Update our negotiated dimensions if the header differs.
                // (Only safe before the pin is connected; after connection the
                //  size is locked by the media type, so we just use what we got.)
                m_iWidth  = static_cast<int>(w);
                m_iHeight = static_cast<int>(h);
            }
            const DWORD pixelBytes = m_iWidth * m_iHeight * 4;
            const BYTE  *src = static_cast<const BYTE*>(m_pNamedView) + kHeaderSize;
            memcpy(pBuffer, src, pixelBytes);
            pSample->SetActualDataLength(pixelBytes);
            return S_OK;
        }

        // Fallback: file-based shared memory at the path given by BRIDGECAM_SHM.
        updateDimensions();
        const long size = m_iWidth * m_iHeight * 4;
        const char *shmPath = getenv("BRIDGECAM_SHM");
        if (shmPath) {
            HANDLE hFile = CreateFileA(shmPath,
                                       GENERIC_READ,
                                       FILE_SHARE_READ | FILE_SHARE_WRITE,
                                       NULL, OPEN_EXISTING,
                                       FILE_ATTRIBUTE_NORMAL, NULL);
            if (hFile != INVALID_HANDLE_VALUE) {
                HANDLE hMap = CreateFileMappingA(hFile, NULL, PAGE_READONLY, 0, 0, NULL);
                if (hMap) {
                    LPVOID map = MapViewOfFile(hMap, FILE_MAP_READ, 0, 0, 0);
                    if (map) { memcpy(pBuffer, map, size); UnmapViewOfFile(map); }
                    else ZeroMemory(pBuffer, size);
                    CloseHandle(hMap);
                } else ZeroMemory(pBuffer, size);
                CloseHandle(hFile);
            } else ZeroMemory(pBuffer, size);
        } else {
            ZeroMemory(pBuffer, size);
        }

        pSample->SetActualDataLength(size);
        return S_OK;
    }

private:
    int    m_iWidth;
    int    m_iHeight;
    HANDLE m_hNamedMap;
    LPVOID m_pNamedView; // persistent read-only view; NULL if mapping not open

    // Open (or re-open) the named Win32 kernel mapping created by Tauri.
    // Safe to call repeatedly — does nothing if already open.
    void ensureNamedMapping()
    {
        if (m_pNamedView) return; // already open

        // Release stale handle if the previous OpenFileMappingA succeeded but
        // MapViewOfFile failed.
        if (m_hNamedMap) { CloseHandle(m_hNamedMap); m_hNamedMap = NULL; }

        m_hNamedMap = OpenFileMappingA(FILE_MAP_READ, FALSE, kNamedMapping);
        if (!m_hNamedMap) return; // Tauri not running yet — will retry next frame

        m_pNamedView = MapViewOfFile(m_hNamedMap, FILE_MAP_READ, 0, 0, 0);
        if (!m_pNamedView) {
            CloseHandle(m_hNamedMap);
            m_hNamedMap = NULL;
        }
    }

    void closeNamedMapping()
    {
        if (m_pNamedView) { UnmapViewOfFile(m_pNamedView); m_pNamedView = NULL; }
        if (m_hNamedMap)  { CloseHandle(m_hNamedMap);      m_hNamedMap  = NULL; }
    }

    // Legacy: read dimensions from BRIDGECAM_WIDTH / BRIDGECAM_HEIGHT env vars
    // (used as fallback when the named mapping is unavailable).
    void updateDimensions()
    {
        const char *w = getenv("BRIDGECAM_WIDTH");
        const char *h = getenv("BRIDGECAM_HEIGHT");
        if (w) { int iw = atoi(w); if (iw > 0) m_iWidth  = iw; }
        if (h) { int ih = atoi(h); if (ih > 0) m_iHeight = ih; }
    }
};

// ---------------------------------------------------------------------------
// CBridgeCamSource
// ---------------------------------------------------------------------------
class CBridgeCamSource : public CSource
{
public:
    static CUnknown * WINAPI CreateInstance(LPUNKNOWN pUnk, HRESULT *pHr)
    {
        CBridgeCamSource *pFilter = new CBridgeCamSource(pUnk, pHr);
        if (!pFilter) *pHr = E_OUTOFMEMORY;
        return pFilter;
    }

    CBridgeCamSource(LPUNKNOWN pUnk, HRESULT *pHr)
      : CSource("BridgeCam Source", pUnk, CLSID_BridgeCamSource, pHr)
    {
        m_pStream = new CBridgeCamStream(pHr, this, L"Out");
        if (!m_pStream) *pHr = E_OUTOFMEMORY;
    }

    ~CBridgeCamSource()
    {
        delete m_pStream;
    }

private:
    CBridgeCamStream *m_pStream;
};

// ---------------------------------------------------------------------------
// DLL entrypoints: COM/registry registration
// Must be run elevated (admin) — DirectShow's device enumerator only reads
// the machine hive (HKLM\Software\Classes = HKCR) for device categories.
// ---------------------------------------------------------------------------

STDAPI DllRegisterServer()
{
    wchar_t modulePath[MAX_PATH];
    if (!GetModuleFileNameW(g_hInst, modulePath, ARRAYSIZE(modulePath)))
        return HRESULT_FROM_WIN32(GetLastError());

    // 1. Register COM InprocServer32 under HKCR\CLSID\{GUID}
    wchar_t clsidKey[128];
    swprintf_s(clsidKey, L"CLSID\\%s", kFilterClsidStr);
    HRESULT hr = SetRegKeyValue(HKEY_CLASSES_ROOT, clsidKey, NULL, kFilterFriendlyName);
    if (FAILED(hr)) return hr;

    wchar_t inprocKey[160];
    swprintf_s(inprocKey, L"%s\\InprocServer32", clsidKey);
    hr = SetRegKeyValue(HKEY_CLASSES_ROOT, inprocKey, NULL, modulePath);
    if (FAILED(hr)) return hr;
    hr = SetRegKeyValue(HKEY_CLASSES_ROOT, inprocKey, L"ThreadingModel", L"Both");
    if (FAILED(hr)) return hr;

    // 2. Add to Video Input Device category so apps see us as a webcam
    wchar_t catInstanceKey[256];
    swprintf_s(catInstanceKey, L"CLSID\\%s\\Instance\\%s",
               kVideoInputCategory, kFilterClsidStr);
    hr = SetRegKeyValue(HKEY_CLASSES_ROOT, catInstanceKey, L"FriendlyName", kFilterFriendlyName);
    if (FAILED(hr)) return hr;
    hr = SetRegKeyValue(HKEY_CLASSES_ROOT, catInstanceKey, L"CLSID", kFilterClsidStr);
    if (FAILED(hr)) return hr;

    // 3. Register the MF virtual-camera source CLSID (needed for NVB / modern apps)
    hr = RegisterMFSource();
    return hr;
}

STDAPI DllUnregisterServer()
{
    wchar_t clsidKey[128];
    swprintf_s(clsidKey, L"CLSID\\%s", kFilterClsidStr);
    DeleteRegKeyTree(HKEY_CLASSES_ROOT, clsidKey);

    wchar_t catInstanceKey[256];
    swprintf_s(catInstanceKey, L"CLSID\\%s\\Instance\\%s",
               kVideoInputCategory, kFilterClsidStr);
    DeleteRegKeyTree(HKEY_CLASSES_ROOT, catInstanceKey);
    UnregisterMFSource();
    return S_OK;
}

// ---------------------------------------------------------------------------
// DllGetClassObject — needed by CoCreateInstance for both the DS filter and
// the MF virtual-camera source.
// ---------------------------------------------------------------------------
extern "C" LONG BridgeCamMF_ActiveObjects();

STDAPI DllCanUnloadNow()
{
    return (BridgeCamMF_ActiveObjects() == 0) ? S_OK : S_FALSE;
}

STDAPI DllGetClassObject(REFCLSID rclsid, REFIID riid, void** ppv)
{
    // Delegate to the MF source factory (handles CLSID_BridgeCamMFSource)
    HRESULT hr = BridgeCamMF_GetClassObject(rclsid, riid, ppv);
    if (SUCCEEDED(hr)) return hr;
    // DS filter CLSID not explicitly handled here; legacy DS enumeration
    // uses ICreateDevEnum / merits and doesn't call DllGetClassObject directly.
    return CLASS_E_CLASSNOTAVAILABLE;
}

BOOL WINAPI DllMain(HINSTANCE hInst, DWORD dwReason, LPVOID)
{
    if (dwReason == DLL_PROCESS_ATTACH) {
        g_hInst = hInst;
        DisableThreadLibraryCalls(hInst);
    }
    return TRUE;
}
