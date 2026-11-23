// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 BridgeCam Contributors
//
// BridgeCamMFSource.cpp
// Windows Virtual Camera source.
//
// Architecture:
//  * The Windows Camera Frame Server calls CoCreateInstance(CLSID_BridgeCamMFSource)
//    requesting IMFActivate.
//  * CBridgeCamActivate (implements IMFActivate + IMFAttributes delegation) is
//    returned.  When the Frame Server needs the actual stream source it calls
//    ActivateObject(IID_IMFMediaSourceEx) which creates CBridgeCamMFSource.
//  * CBridgeCamMFSource implements IMFMediaSourceEx + IKsControl stubs.
//  * RequestSample() reads RGBA pixels from the named Win32 SHM
//    "Local\BridgeCamFrameBuffer" written by the Tauri desktop app.

#include <windows.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mferror.h>
#include <ks.h>
#include <ksmedia.h>
#include <ksproxy.h>
#include <mfvirtualcamera.h>  // MF_VIRTUALCAMERA_PROVIDE_ASSOCIATED_CAMERA_SOURCES
#include <propvarutil.h>
#include <strsafe.h>
#include <new>
#include <cstring>
#include <cstdio>

#pragma comment(lib, "mfuuid.lib")
#pragma comment(lib, "mfplat.lib")
#pragma comment(lib, "mfsensorgroup.lib")
#pragma comment(lib, "propsys.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "winmm.lib")  // timeBeginPeriod / timeEndPeriod

extern HINSTANCE g_hInst;

// ---------------------------------------------------------------------------
// GUID / constants
// ---------------------------------------------------------------------------
// {B9EAAFE1-1234-5678-ABCD-1234567890AB}
const GUID CLSID_BridgeCamMFSource = {
    0xb9eaafe1, 0x1234, 0x5678,
    { 0xab, 0xcd, 0x12, 0x34, 0x56, 0x78, 0x90, 0xab }
};

// COM marshaling / agility IIDs — defined locally to avoid uuid.lib dependency.
// IMarshal {00000003-0000-0000-C000-000000000046}
static const GUID LOCAL_IID_IMarshal = {
    0x00000003, 0x0000, 0x0000,
    {0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46}
};
// IAgileObject {94EA2B94-E9CC-49E0-C0FF-EE64CA8F5B90}
static const GUID LOCAL_IID_IAgileObject = {
    0x94ea2b94, 0xe9cc, 0x49e0,
    {0xc0, 0xff, 0xee, 0x64, 0xca, 0x8f, 0x5b, 0x90}
};

static const WCHAR* kFriendlyName   = L"BridgeCam Source";
// Frame Server (Windows Camera Frame Server service) runs in Session 0,
// while user apps (Tauri, frame_writer) run in Session 1.  Local\ named
// objects are session-scoped, so a Local\ object created in Session 1 is
// invisible to Session 0 — causing EnsureMapping to always fail.
//
// Fix: skip named kernel objects entirely.  Instead, both sides share a
// file at a well-known ProgramData path.  Filesystem objects are not session-
// scoped, so Session 0 and Session 1 can both open the same file.
static const char   kShmFile[]        = "C:\\ProgramData\\BridgeCam\\framebuffer.dat";
static const DWORD  kHdrSize          = 12; // [width][height][frame_seq]
// Max allocation: 4K UHD RGBA + header
static const DWORD  kMaxMappingBytes  = 3840u * 2160u * 4u + 12u;
static const UINT32 kDefW = 1920, kDefH = 1080;
static const UINT32 kFPS_N = 30,  kFPS_D = 1;

// ---------------------------------------------------------------------------
// Debug QI log (file logging enabled only in Debug builds)
// ---------------------------------------------------------------------------
static volatile LONG g_cMFObjects = 0;

extern "C" LONG BridgeCamMF_ActiveObjects()
{
    return InterlockedCompareExchange(&g_cMFObjects, 0, 0);
}

static void WriteLogLine(const char* line)
{
#ifdef _DEBUG
    OutputDebugStringA(line);

    char path[MAX_PATH] = {};
    if (GetEnvironmentVariableA("TEMP", path, MAX_PATH) > 0) {
        StringCchCatA(path, MAX_PATH, "\\bridgecam_qi.log");
        HANDLE hf = CreateFileA(path, GENERIC_WRITE, FILE_SHARE_READ|FILE_SHARE_WRITE,
                                nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
        if (hf != INVALID_HANDLE_VALUE) {
            SetFilePointer(hf, 0, nullptr, FILE_END);
            DWORD written; WriteFile(hf, line, (DWORD)strlen(line), &written, nullptr);
            CloseHandle(hf);
        }
    }

    const char* progdir = "C:\\ProgramData\\BridgeCam";
    CreateDirectoryA(progdir, nullptr);
    char pdata[MAX_PATH];
    StringCchCopyA(pdata, MAX_PATH, progdir);
    StringCchCatA(pdata, MAX_PATH, "\\vcam_qi.log");
    HANDLE hf2 = CreateFileA(pdata, GENERIC_WRITE, FILE_SHARE_READ|FILE_SHARE_WRITE,
                             nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (hf2 != INVALID_HANDLE_VALUE) {
        SetFilePointer(hf2, 0, nullptr, FILE_END);
        DWORD written; WriteFile(hf2, line, (DWORD)strlen(line), &written, nullptr);
        CloseHandle(hf2);
    }
#else
    (void)line;
#endif
}

static void LogQI(const char* tag, REFIID riid, HRESULT hr)
{
    OLECHAR gs[40] = {};
    StringFromGUID2(riid, gs, ARRAYSIZE(gs));
    char line[256];
    StringCchPrintfA(line, ARRAYSIZE(line), "[PID %lu] %s {%ls} -> 0x%08lX\r\n",
                     GetCurrentProcessId(), tag, gs, (unsigned long)hr);
    WriteLogLine(line);
}

static void LogMsg(const char* msg)
{
    char line[512];
    StringCchPrintfA(line, ARRAYSIZE(line), "[PID %lu] %s\r\n", GetCurrentProcessId(), msg);
    WriteLogLine(line);
}

// ---------------------------------------------------------------------------
// Forward declarations
// ---------------------------------------------------------------------------
class CBridgeCamMFStream;
class CBridgeCamMFSource;

// ---------------------------------------------------------------------------
// IKsControl stub
// ---------------------------------------------------------------------------
class CKsControlStub : public IKsControl
{
public:
    STDMETHODIMP KsProperty(PKSPROPERTY p, ULONG cb, LPVOID buf, ULONG bufLen, ULONG* written) {
        if (written) *written = 0;
        // Virtual camera with no hardware controls — ERROR_SET_NOT_FOUND
        // is the correct response (not E_NOTIMPL which can confuse FrameServer).
        return HRESULT_FROM_WIN32(ERROR_SET_NOT_FOUND);
    }
    STDMETHODIMP KsMethod(PKSMETHOD, ULONG, LPVOID, ULONG, ULONG*)     { return HRESULT_FROM_WIN32(ERROR_SET_NOT_FOUND); }
    STDMETHODIMP KsEvent(PKSEVENT, ULONG, LPVOID, ULONG, ULONG*)       { return HRESULT_FROM_WIN32(ERROR_SET_NOT_FOUND); }
};

// ---------------------------------------------------------------------------
// CBridgeCamActivate — returned by DllGetClassObject / IClassFactory.
// Wraps an internal IMFAttributes and implements IMFActivate.
// ---------------------------------------------------------------------------
class CBridgeCamActivate final : public IMFActivate, public CKsControlStub
{
    LONG              m_cRef;
    IMFAttributes*    m_pAttr;
    CBridgeCamMFSource* m_pSrc;  // cached once ActivateObject is called
    IUnknown*         m_pFTM;   // free-threaded marshaler aggregate

public:
    CBridgeCamActivate() : m_cRef(1L), m_pAttr(nullptr), m_pSrc(nullptr), m_pFTM(nullptr)
    {
        InterlockedIncrement(&g_cMFObjects);
        MFCreateAttributes(&m_pAttr, 8);
        CoCreateFreeThreadedMarshaler(
            static_cast<IUnknown*>(static_cast<IMFActivate*>(this)), &m_pFTM);
        m_pAttr->SetUINT32(MF_VIRTUALCAMERA_PROVIDE_ASSOCIATED_CAMERA_SOURCES, 1);
    }
    ~CBridgeCamActivate()
    {
        if (m_pFTM) { m_pFTM->Release(); m_pFTM = nullptr; }
        if (m_pAttr) { m_pAttr->Release(); m_pAttr = nullptr; }
        InterlockedDecrement(&g_cMFObjects);
    }

    // IUnknown
    STDMETHODIMP_(ULONG) AddRef()  { return (ULONG)InterlockedIncrement(&m_cRef); }
    STDMETHODIMP_(ULONG) Release() {
        ULONG c = (ULONG)InterlockedDecrement(&m_cRef);
        if (!c) delete this; return c;
    }
    STDMETHODIMP QueryInterface(REFIID riid, void** ppv)
    {
        if (!ppv) return E_POINTER; *ppv = nullptr;
        HRESULT hr = E_NOINTERFACE;
        if (riid == IID_IUnknown || riid == IID_IMFAttributes || riid == IID_IMFActivate)
        { *ppv = static_cast<IMFActivate*>(this); AddRef(); hr = S_OK; }
        else if (riid == __uuidof(IKsControl))
        { *ppv = static_cast<IKsControl*>(this); AddRef(); hr = S_OK; }
        else if (riid == LOCAL_IID_IAgileObject)
        { *ppv = static_cast<IUnknown*>(static_cast<IMFActivate*>(this)); AddRef(); hr = S_OK; }
        else if (riid == LOCAL_IID_IMarshal && m_pFTM)
        { return m_pFTM->QueryInterface(riid, ppv); }
        LogQI("Activate::QI", riid, hr);
        return hr;
    }

    // IMFActivate
    STDMETHODIMP ActivateObject(REFIID riid, void** ppv);  // defined after CBridgeCamMFSource
    STDMETHODIMP ShutdownObject();
    STDMETHODIMP DetachObject();

    // ── IMFAttributes delegation to m_pAttr ─────────────────────────────────
    STDMETHODIMP GetItem(REFGUID k, PROPVARIANT* v)                       { HRESULT hr=m_pAttr->GetItem(k,v); LogQI("Act::GetItem",k,hr); return hr; }
    STDMETHODIMP GetItemType(REFGUID k, MF_ATTRIBUTE_TYPE* t)             { return m_pAttr->GetItemType(k,t); }
    STDMETHODIMP CompareItem(REFGUID k, REFPROPVARIANT v, BOOL* r)        { return m_pAttr->CompareItem(k,v,r); }
    STDMETHODIMP Compare(IMFAttributes* a, MF_ATTRIBUTES_MATCH_TYPE t, BOOL* r) { return m_pAttr->Compare(a,t,r); }
    STDMETHODIMP GetUINT32(REFGUID k, UINT32* v)                          { HRESULT hr=m_pAttr->GetUINT32(k,v); LogQI("Act::GetUINT32",k,hr); return hr; }
    STDMETHODIMP GetUINT64(REFGUID k, UINT64* v)                          { return m_pAttr->GetUINT64(k,v); }
    STDMETHODIMP GetDouble(REFGUID k, double* v)                          { return m_pAttr->GetDouble(k,v); }
    STDMETHODIMP GetGUID(REFGUID k, GUID* v)                              { HRESULT hr=m_pAttr->GetGUID(k,v); LogQI("Act::GetGUID",k,hr); return hr; }
    STDMETHODIMP GetStringLength(REFGUID k, UINT32* l)                    { return m_pAttr->GetStringLength(k,l); }
    STDMETHODIMP GetString(REFGUID k, LPWSTR v, UINT32 s, UINT32* l)      { HRESULT hr=m_pAttr->GetString(k,v,s,l); LogQI("Act::GetStr",k,hr); return hr; }
    STDMETHODIMP GetAllocatedString(REFGUID k, LPWSTR* v, UINT32* l)      { HRESULT hr=m_pAttr->GetAllocatedString(k,v,l); LogQI("Act::GetAllocStr",k,hr); return hr; }
    STDMETHODIMP GetBlobSize(REFGUID k, UINT32* s)                        { return m_pAttr->GetBlobSize(k,s); }
    STDMETHODIMP GetBlob(REFGUID k, UINT8* b, UINT32 bs, UINT32* ws)      { return m_pAttr->GetBlob(k,b,bs,ws); }
    STDMETHODIMP GetAllocatedBlob(REFGUID k, UINT8** b, UINT32* s)        { return m_pAttr->GetAllocatedBlob(k,b,s); }
    STDMETHODIMP GetUnknown(REFGUID k, REFIID r, LPVOID* v)               { HRESULT hr=m_pAttr->GetUnknown(k,r,v); LogQI("Act::GetUnk",k,hr); return hr; }
    STDMETHODIMP SetItem(REFGUID k, REFPROPVARIANT v)                     { LogQI("Act::SetItem",k,S_OK); return m_pAttr->SetItem(k,v); }
    STDMETHODIMP DeleteItem(REFGUID k)                                    { LogQI("Act::DeleteItem",k,S_OK); return m_pAttr->DeleteItem(k); }
    STDMETHODIMP DeleteAllItems()                                         { LogMsg("Act::DeleteAllItems"); return m_pAttr->DeleteAllItems(); }
    STDMETHODIMP SetUINT32(REFGUID k, UINT32 v)                           { LogQI("Act::SetUINT32",k,S_OK); return m_pAttr->SetUINT32(k,v); }
    STDMETHODIMP SetUINT64(REFGUID k, UINT64 v)                           { LogQI("Act::SetUINT64",k,S_OK); return m_pAttr->SetUINT64(k,v); }
    STDMETHODIMP SetDouble(REFGUID k, double v)                           { LogQI("Act::SetDouble",k,S_OK); return m_pAttr->SetDouble(k,v); }
    STDMETHODIMP SetGUID(REFGUID k, REFGUID v)                            { LogQI("Act::SetGUID",k,S_OK); return m_pAttr->SetGUID(k,v); }
    STDMETHODIMP SetString(REFGUID k, LPCWSTR v)                          { LogQI("Act::SetString",k,S_OK); return m_pAttr->SetString(k,v); }
    STDMETHODIMP SetBlob(REFGUID k, const UINT8* b, UINT32 s)             { LogQI("Act::SetBlob",k,S_OK); return m_pAttr->SetBlob(k,b,s); }
    STDMETHODIMP SetUnknown(REFGUID k, IUnknown* v)                       { LogQI("Act::SetUnknown",k,S_OK); return m_pAttr->SetUnknown(k,v); }
    STDMETHODIMP LockStore()                                              { return m_pAttr->LockStore(); }
    STDMETHODIMP UnlockStore()                                            { return m_pAttr->UnlockStore(); }
    STDMETHODIMP GetCount(UINT32* c)                                      { return m_pAttr->GetCount(c); }
    STDMETHODIMP GetItemByIndex(UINT32 i, GUID* k, PROPVARIANT* v)        { return m_pAttr->GetItemByIndex(i,k,v); }
    STDMETHODIMP CopyAllItems(IMFAttributes* d)                           { return m_pAttr->CopyAllItems(d); }
};

// ---------------------------------------------------------------------------
// CBridgeCamMFSource — implements IMFMediaSourceEx + IKsControl
// ---------------------------------------------------------------------------
class CBridgeCamMFSource final
    : public IMFMediaSourceEx
    , public IMFGetService
    , public IMFSampleAllocatorControl
    , public IMFRealTimeClientEx
    , public CKsControlStub
{
public:
    CBridgeCamMFSource() : m_cRef(1L), m_pEventQueue(nullptr), m_pPD(nullptr),
                            m_pStream(nullptr), m_pSrcAttr(nullptr),
                            m_pStreamSD(nullptr), m_pStreamAttrs(nullptr),
                            m_pFTM(nullptr), m_pProvidedAlloc(nullptr),
                            m_state(STATE_STOPPED) { InterlockedIncrement(&g_cMFObjects); }
    ~CBridgeCamMFSource() {
        LogMsg("Source::DESTRUCTOR called");
        InterlockedDecrement(&g_cMFObjects);
    }

    enum State { STATE_STOPPED, STATE_STARTED, STATE_PAUSED };

    HRESULT Initialize(IMFAttributes* pActivateAttrs);

    // IUnknown
    STDMETHODIMP_(ULONG) AddRef()  {
        ULONG c = (ULONG)InterlockedIncrement(&m_cRef);
        if (c <= 5) { char buf[80]; StringCchPrintfA(buf,80,"Source::AddRef -> %lu",c); LogMsg(buf); }
        return c;
    }
    STDMETHODIMP_(ULONG) Release() {
        ULONG c = (ULONG)InterlockedDecrement(&m_cRef);
        { char buf[80]; StringCchPrintfA(buf,80,"Source::Release -> %lu",c); LogMsg(buf); }
        if (!c) delete this; return c;
    }
    STDMETHODIMP QueryInterface(REFIID riid, void** ppv)
    {
        if (!ppv) return E_POINTER; *ppv = nullptr; HRESULT hr = E_NOINTERFACE;
        if (riid==IID_IUnknown||riid==IID_IMFMediaEventGenerator||riid==IID_IMFMediaSource||riid==__uuidof(IMFMediaSourceEx))
        { *ppv = static_cast<IMFMediaSourceEx*>(this); AddRef(); hr = S_OK; }
        else if (riid==IID_IMFGetService)
        { *ppv = static_cast<IMFGetService*>(this); AddRef(); hr = S_OK; }
        else if (riid==__uuidof(IMFSampleAllocatorControl))
        { *ppv = static_cast<IMFSampleAllocatorControl*>(this); AddRef(); hr = S_OK; }
        else if (riid==__uuidof(IKsControl))
        { *ppv = static_cast<IKsControl*>(this); AddRef(); hr = S_OK; }
        else if (riid==__uuidof(IMFRealTimeClientEx))
        { *ppv = static_cast<IMFRealTimeClientEx*>(this); AddRef(); hr = S_OK; }
        else if (riid == LOCAL_IID_IAgileObject)
        { *ppv = static_cast<IUnknown*>(static_cast<IMFMediaSourceEx*>(this)); AddRef(); hr = S_OK; }
        else if (riid == LOCAL_IID_IMarshal && m_pFTM)
        { return m_pFTM->QueryInterface(riid, ppv); }
        LogQI("Source::QI", riid, hr);
        return hr;
    }

    // IMFMediaEventGenerator
    STDMETHODIMP BeginGetEvent(IMFAsyncCallback* c,IUnknown* s) {
        HRESULT hr = m_pEventQueue?m_pEventQueue->BeginGetEvent(c,s):MF_E_SHUTDOWN;
        static LONG sBgeCount = 0;
        LONG n = InterlockedIncrement(&sBgeCount);
        if (n <= 3) { char buf[80]; StringCchPrintfA(buf,80,"Source::BeginGetEvent #%ld -> 0x%08lX",n,(unsigned long)hr); LogMsg(buf); }
        return hr;
    }
    STDMETHODIMP EndGetEvent(IMFAsyncResult* r,IMFMediaEvent** e) { return m_pEventQueue?m_pEventQueue->EndGetEvent(r,e):MF_E_SHUTDOWN; }
    STDMETHODIMP GetEvent(DWORD f,IMFMediaEvent** e) { return m_pEventQueue?m_pEventQueue->GetEvent(f,e):MF_E_SHUTDOWN; }
    STDMETHODIMP QueueEvent(MediaEventType t,REFGUID g,HRESULT h,const PROPVARIANT* v) { return m_pEventQueue?m_pEventQueue->QueueEventParamVar(t,g,h,v):MF_E_SHUTDOWN; }

    // IMFMediaSource
    STDMETHODIMP GetCharacteristics(DWORD* p) {
        if(!p) return E_POINTER;
        *p = MFMEDIASOURCE_IS_LIVE;
        LogMsg("Source::GetCharacteristics -> MFMEDIASOURCE_IS_LIVE");
        return S_OK;
    }
    STDMETHODIMP CreatePresentationDescriptor(IMFPresentationDescriptor** pp) {
        if(!pp) return E_POINTER;
        if(!m_pPD) { LogMsg("Source::CreatePresentationDescriptor -> NOT_INITIALIZED"); return MF_E_NOT_INITIALIZED; }
        HRESULT hr = m_pPD->Clone(pp);
        char buf[128];
        StringCchPrintfA(buf, 128, "Source::CreatePresentationDescriptor -> 0x%08lX", (unsigned long)hr);
        LogMsg(buf);
        return hr;
    }
    STDMETHODIMP Start(IMFPresentationDescriptor*,const GUID*,const PROPVARIANT*);
    STDMETHODIMP Stop();
    STDMETHODIMP Pause() { m_state=STATE_PAUSED; return m_pEventQueue->QueueEventParamVar(MESourcePaused,GUID_NULL,S_OK,nullptr); }
    STDMETHODIMP Shutdown();

    // IMFMediaSourceEx
    STDMETHODIMP GetSourceAttributes(IMFAttributes** pp)
    {
        if (!pp) return E_POINTER;
        LogMsg("Source::GetSourceAttributes called");
        // m_pSrcAttr is pre-built in Initialize() — matches MS sample pattern
        // where source attributes include all activate attributes + sensor profile.
        if (!m_pSrcAttr) return MF_E_NOT_INITIALIZED;
        *pp = m_pSrcAttr; (*pp)->AddRef(); return S_OK;
    }
    STDMETHODIMP GetStreamAttributes(DWORD dwStreamIdentifier, IMFAttributes** pp)
    {
        char _gsaBuf[128]; StringCchPrintfA(_gsaBuf, 128, "Source::GetStreamAttributes called (streamId=%lu)", dwStreamIdentifier);
        LogMsg(_gsaBuf);
        if(!pp) return E_POINTER;
        // Return a separate plain IMFAttributes store (NOT the StreamDescriptor).
        // This matches the MS sample (SimpleMediaSource::GetStreamAttributes returns
        // m_spAttributes, not the SD). Returning the SD directly can confuse
        // Frame Server if it QIs the returned object for IMFStreamDescriptor.
        if (!m_pStreamAttrs) return MF_E_NOT_INITIALIZED;
        *pp = m_pStreamAttrs; (*pp)->AddRef();
        return S_OK;
    }

    // IMFSampleAllocatorControl — required by Frame Server (all MS sample
    // sources implement this interface).
    STDMETHODIMP SetDefaultAllocator(DWORD dwOutputStreamID, IUnknown* pAllocator) {
        LogMsg("Source::SetDefaultAllocator called");
        if (m_pProvidedAlloc) { m_pProvidedAlloc->Release(); m_pProvidedAlloc = nullptr; }
        if (pAllocator) {
            pAllocator->QueryInterface(__uuidof(IMFVideoSampleAllocator),
                                       reinterpret_cast<void**>(&m_pProvidedAlloc));
        }
        return S_OK;
    }
    STDMETHODIMP GetAllocatorUsage(DWORD dwOutputStreamID, DWORD* pdwInputStreamID, MFSampleAllocatorUsage* peUsage) {
        LogMsg("Source::GetAllocatorUsage called");
        if (!pdwInputStreamID || !peUsage) return E_POINTER;
        *pdwInputStreamID = dwOutputStreamID;
        *peUsage = MFSampleAllocatorUsage_UsesProvidedAllocator;
        return S_OK;
    }
    STDMETHODIMP SetD3DManager(IUnknown*) { return S_OK; }

    // IMFRealTimeClientEx — Frame Server queries for this to manage thread priorities.
    // Stubs matching MS SimpleMediaSource sample.
    STDMETHODIMP RegisterThreadsEx(DWORD* pdwTaskIndex, LPCWSTR wszClassName, LONG lBasePriority) {
        LogMsg("Source::RegisterThreadsEx called");
        return S_OK;
    }
    STDMETHODIMP UnregisterThreads() {
        LogMsg("Source::UnregisterThreads called");
        return S_OK;
    }
    STDMETHODIMP SetWorkQueueEx(DWORD dwMultithreadedWorkQueueId, LONG lWorkItemBasePriority) {
        char buf[128]; StringCchPrintfA(buf, 128, "Source::SetWorkQueueEx called (queueId=%lu prio=%ld)",
                                        dwMultithreadedWorkQueueId, lWorkItemBasePriority);
        LogMsg(buf);
        return S_OK;
    }

    // IMFGetService
    STDMETHODIMP GetService(REFGUID g, REFIID r, LPVOID* ppv)
    {
        if (!ppv) return E_POINTER;
        LogQI("Source::GetService(svc)", g, S_OK);
        LogQI("Source::GetService(iid)", r, S_OK);
        static const GUID MR_VIDEO_ACCELERATION_SERVICE =
            {0xefef5175,0x5c7d,0x4ce2,{0xbb,0xbd,0x34,0xff,0x8b,0xca,0x65,0x54}};
        // MF_RATE_CONTROL_SERVICE = {866FA297-B878-473B-9B2E-8B3A4BD7C5B5}
        static const GUID MF_RATE_CONTROL_SERVICE =
            {0x866fa297,0xb878,0x473b,{0x9b,0x2e,0x8b,0x3a,0x4b,0xd7,0xc5,0xb5}};
        // MF_MEDIASOURCE_SERVICE = {F72A7B64-BCA7-4A11-81C4-ACE0E5B99A36}
        static const GUID MF_MEDIASOURCE_SERVICE_GUID =
            {0xf72a7b64,0xbca7,0x4a11,{0x81,0xc4,0xac,0xe0,0xe5,0xb9,0x9a,0x36}};
        if (g==MR_VIDEO_ACCELERATION_SERVICE && r==__uuidof(IKsControl))
        { *ppv=static_cast<IKsControl*>(this); AddRef(); LogMsg("Source::GetService -> IKsControl OK"); return S_OK; }
        // Match MS sample pattern: delegate rate control and mediasource services to QI
        if (g==MF_RATE_CONTROL_SERVICE || g==MF_MEDIASOURCE_SERVICE_GUID)
        { LogMsg("Source::GetService -> delegating to QI"); return QueryInterface(r, ppv); }
        // CRITICAL: MS sample (SimpleMediaSource) delegates GUID_NULL to QueryInterface.
        // Frame Server calls GetService(GUID_NULL, IID) to probe for optional interfaces.
        // Returning MF_E_UNSUPPORTED_SERVICE is wrong — QI returns E_NOINTERFACE for
        // unknown IIDs which Frame Server interprets as "not available" (acceptable).
        // Returning MF_E_UNSUPPORTED_SERVICE may be treated as a fatal error.
        static const GUID GUID_NULL_LOCAL = {0,0,0,{0,0,0,0,0,0,0,0}};
        if (g == GUID_NULL_LOCAL)
        {
            LogMsg("Source::GetService(GUID_NULL) -> delegating to QI");
            return QueryInterface(r, ppv);
        }
        *ppv = nullptr;
        LogMsg("Source::GetService -> MF_E_UNSUPPORTED_SERVICE");
        return MF_E_UNSUPPORTED_SERVICE;
    }

    CBridgeCamMFStream* Stream() const { return m_pStream; }

private:
    LONG                        m_cRef;
    IMFMediaEventQueue*         m_pEventQueue;
    IMFPresentationDescriptor*  m_pPD;
    CBridgeCamMFStream*         m_pStream;
    IMFAttributes*              m_pSrcAttr;
    IMFStreamDescriptor*        m_pStreamSD;  // stream descriptor in PD
    IMFAttributes*              m_pStreamAttrs; // returned from GetStreamAttributes (separate from SD)
    IUnknown*                   m_pFTM;        // free-threaded marshaler aggregate
    IMFVideoSampleAllocator*    m_pProvidedAlloc; // allocator from Frame Server
    State                       m_state;

    static HRESULT BuildMediaType(UINT32 w, UINT32 h, const GUID& subtype, IMFMediaType** ppType);
};

// ---------------------------------------------------------------------------
// CBridgeCamMFStream
// ---------------------------------------------------------------------------
class CBridgeCamMFStream final : public IMFMediaStream2
{
public:
    CBridgeCamMFStream() : m_cRef(1L), m_pSrc(nullptr), m_pEventQueue(nullptr),
                            m_pSD(nullptr), m_hMap(NULL), m_pView(nullptr),
                            m_iW(kDefW), m_iH(kDefH), m_llTime(0),
                            m_bActive(false), m_bShutdown(false),
                            m_streamState(MF_STREAM_STATE_STOPPED),
                            m_subtype(MFVideoFormat_NV12),
                            m_pSampAlloc(nullptr), m_bAllocReady(false),
                            m_lastSeq(0xFFFFFFFF) {}

    HRESULT Init(CBridgeCamMFSource* s, IMFStreamDescriptor* sd);
    void Shutdown(); void SetActive(bool b) { m_bActive = b; }

    // Sample allocator — provided by Frame Server or created during Start()
    void SetSampleAllocator(IMFVideoSampleAllocator* pAlloc) {
        if (m_pSampAlloc) { m_pSampAlloc->Release(); m_pSampAlloc = nullptr; }
        m_pSampAlloc = pAlloc;
        if (m_pSampAlloc) m_pSampAlloc->AddRef();
        m_bAllocReady = false; // must re-init
    }
    HRESULT InitSampleAllocator() {
        if (m_bAllocReady) return S_OK;
        // If no allocator was provided by Frame Server, create our own
        if (!m_pSampAlloc) {
            HRESULT hr = MFCreateVideoSampleAllocatorEx(
                __uuidof(IMFVideoSampleAllocator),
                reinterpret_cast<void**>(&m_pSampAlloc));
            if (FAILED(hr)) {
                char buf[128]; StringCchPrintfA(buf, 128,
                    "InitSampleAllocator: MFCreateVideoSampleAllocatorEx FAILED 0x%08lX",
                    (unsigned long)hr);
                LogMsg(buf); return hr;
            }
        }
        IMFMediaTypeHandler* pHandler = nullptr;
        IMFMediaType* pType = nullptr;
        HRESULT hr = E_FAIL;
        if (m_pSD && SUCCEEDED(m_pSD->GetMediaTypeHandler(&pHandler))) {
            if (SUCCEEDED(pHandler->GetCurrentMediaType(&pType))) {
                hr = m_pSampAlloc->InitializeSampleAllocator(10, pType);
                char buf[128]; StringCchPrintfA(buf, 128,
                    "InitSampleAllocator: hr=0x%08lX", (unsigned long)hr);
                LogMsg(buf);
                pType->Release();
            }
            pHandler->Release();
        }
        if (SUCCEEDED(hr)) m_bAllocReady = true;
        return hr;
    }

    STDMETHODIMP_(ULONG) AddRef()  { return (ULONG)InterlockedIncrement(&m_cRef); }
    STDMETHODIMP_(ULONG) Release() { ULONG c=(ULONG)InterlockedDecrement(&m_cRef); if(!c) delete this; return c; }
    STDMETHODIMP QueryInterface(REFIID riid, void** ppv) {
        if (!ppv) return E_POINTER; *ppv=nullptr;
        if (riid==IID_IUnknown||riid==IID_IMFMediaEventGenerator||riid==IID_IMFMediaStream||riid==__uuidof(IMFMediaStream2))
        { *ppv=static_cast<IMFMediaStream2*>(this); AddRef(); return S_OK; }
        return E_NOINTERFACE;
    }
    STDMETHODIMP BeginGetEvent(IMFAsyncCallback* c,IUnknown* s) { return m_pEventQueue?m_pEventQueue->BeginGetEvent(c,s):MF_E_SHUTDOWN; }
    STDMETHODIMP EndGetEvent(IMFAsyncResult* r,IMFMediaEvent** e) { return m_pEventQueue?m_pEventQueue->EndGetEvent(r,e):MF_E_SHUTDOWN; }
    STDMETHODIMP GetEvent(DWORD f,IMFMediaEvent** e) { return m_pEventQueue?m_pEventQueue->GetEvent(f,e):MF_E_SHUTDOWN; }
    STDMETHODIMP QueueEvent(MediaEventType t,REFGUID g,HRESULT h,const PROPVARIANT* v) { return m_pEventQueue?m_pEventQueue->QueueEventParamVar(t,g,h,v):MF_E_SHUTDOWN; }
    STDMETHODIMP GetMediaSource(IMFMediaSource** pp) {
        if(!pp) return E_POINTER; *pp=static_cast<IMFMediaSourceEx*>(m_pSrc); (*pp)->AddRef(); return S_OK;
    }
    STDMETHODIMP GetStreamDescriptor(IMFStreamDescriptor** pp) {
        if(!pp) return E_POINTER; if(!m_pSD) return MF_E_NOT_INITIALIZED;
        *pp=m_pSD; (*pp)->AddRef(); return S_OK;
    }
    STDMETHODIMP RequestSample(IUnknown* tok);

    // IMFMediaStream2
    STDMETHODIMP SetStreamState(MF_STREAM_STATE state) {
        char buf[80]; StringCchPrintfA(buf,80,"Stream::SetStreamState(%d)", (int)state);
        LogMsg(buf);
        m_streamState = state;
        m_bActive = (state == MF_STREAM_STATE_RUNNING);
        return S_OK;
    }
    STDMETHODIMP GetStreamState(MF_STREAM_STATE* pState) {
        if (!pState) return E_POINTER;
        *pState = m_streamState;
        return S_OK;
    }

private:
    LONG m_cRef; CBridgeCamMFSource* m_pSrc; IMFMediaEventQueue* m_pEventQueue;
    IMFStreamDescriptor* m_pSD; HANDLE m_hMap; LPVOID m_pView;
    UINT32 m_iW, m_iH; LONGLONG m_llTime; bool m_bActive, m_bShutdown;
    MF_STREAM_STATE m_streamState;
    GUID m_subtype;
    IMFVideoSampleAllocator* m_pSampAlloc; // video sample allocator (2D buffers)
    bool m_bAllocReady;
    DWORD m_lastSeq; // last frame_seq delivered — used to skip stale frames
    UINT64 m_shmFileSize = 0;

    void EnsureMapping() {
        if (m_pView) return;
        if (!m_hMap) {
            HANDLE hFile = CreateFileA(kShmFile, GENERIC_READ,
                                       FILE_SHARE_READ|FILE_SHARE_WRITE,
                                       nullptr, OPEN_EXISTING,
                                       FILE_ATTRIBUTE_NORMAL, nullptr);
            if (hFile == INVALID_HANDLE_VALUE) {
                DWORD err = GetLastError();
                static LONG sMissCount = 0;
                LONG mc = InterlockedIncrement(&sMissCount);
                if (mc <= 3 || (mc % 300) == 0) {
                    char buf[256];
                    DWORD sid = 0; ProcessIdToSessionId(GetCurrentProcessId(), &sid);
                    StringCchPrintfA(buf, 256,
                        "EnsureMapping: CreateFile FAILED err=%lu path=%s pid=%lu session=%lu",
                        err, kShmFile, GetCurrentProcessId(), sid);
                    LogMsg(buf);
                }
                return;
            }
            LARGE_INTEGER liSize = {};
            if (!GetFileSizeEx(hFile, &liSize) || liSize.QuadPart < (LONGLONG)kHdrSize) {
                CloseHandle(hFile);
                LogMsg("EnsureMapping: framebuffer.dat too small or unreadable");
                return;
            }
            m_shmFileSize = (UINT64)liSize.QuadPart;
            m_hMap = CreateFileMappingA(hFile, nullptr, PAGE_READONLY, 0, 0, nullptr);
            CloseHandle(hFile);
            if (!m_hMap) {
                m_shmFileSize = 0;
                char buf[128];
                StringCchPrintfA(buf, 128, "EnsureMapping: CreateFileMapping FAILED err=%lu", GetLastError());
                LogMsg(buf);
                return;
            }
            LogMsg("EnsureMapping: file opened and mapping created");
        }
        m_pView = MapViewOfFile(m_hMap, FILE_MAP_READ, 0, 0, 0);
        if (!m_pView) {
            char buf[128];
            StringCchPrintfA(buf, 128, "EnsureMapping: MapViewOfFile FAILED err=%lu", GetLastError());
            LogMsg(buf);
            CloseHandle(m_hMap); m_hMap=NULL; m_shmFileSize=0; return;
        }
        const DWORD* hdr = static_cast<const DWORD*>(m_pView);
        char buf[128];
        StringCchPrintfA(buf, 128, "EnsureMapping: file-backed SHM mapped successfully outDim=%ux%u shmDim=%ux%u",
                         m_iW, m_iH, hdr[0], hdr[1]);
        LogMsg(buf);
    }
    HRESULT MakeSample(IUnknown* tok, bool black, IMFSample** pp);
};

// ---------------------------------------------------------------------------
// CBridgeCamActivate::ActivateObject / Shutdown / Detach
// ---------------------------------------------------------------------------
STDMETHODIMP CBridgeCamActivate::ActivateObject(REFIID riid, void** ppv)
{
    LogMsg("Activate::ActivateObject called");
    // Always release any previous source.  Frame Server calls Shutdown() on
    // the source during enumeration, then calls ActivateObject AGAIN for
    // actual capture.  If we reuse the dead (Shutdown'd) source, Start()
    // will fail and the consumer sees black.  Recreating is cheap and safe.
    if (m_pSrc) {
        LogMsg("Activate::ActivateObject: releasing previous source");
        m_pSrc->Release();
        m_pSrc = nullptr;
    }
    m_pSrc = new(std::nothrow) CBridgeCamMFSource();
    if (!m_pSrc) return E_OUTOFMEMORY;
    // CRITICAL: pass the activate's attributes to Initialize.
    // MS sample: SimpleMediaSource::Initialize(IMFAttributes* pAttributes)
    // copies all activate attrs into source attrs via CopyAllItems.
    // Frame Server sets metadata on the activate that MUST appear in
    // GetSourceAttributes() for validation — without this, FS aborts.
    HRESULT hr = m_pSrc->Initialize(m_pAttr);
    if (FAILED(hr)) { m_pSrc->Release(); m_pSrc=nullptr; return hr; }
    return m_pSrc->QueryInterface(riid, ppv);
}
STDMETHODIMP CBridgeCamActivate::ShutdownObject()
{
    if (m_pSrc) { m_pSrc->Shutdown(); m_pSrc->Release(); m_pSrc=nullptr; }
    return S_OK;
}
STDMETHODIMP CBridgeCamActivate::DetachObject()
{
    if (m_pSrc) { m_pSrc->Release(); m_pSrc=nullptr; }
    return S_OK;
}

// ---------------------------------------------------------------------------
// CBridgeCamMFSource implementation
// ---------------------------------------------------------------------------
HRESULT CBridgeCamMFSource::Initialize(IMFAttributes* pActivateAttrs)
{
    LogMsg("Source::Initialize called");

    // ── 1. Create source attributes (matching MS sample _CreateSourceAttributes) ──
    // First copy ALL activate attributes, then overlay our specific ones.
    // Frame Server sets metadata on the activate that MUST appear in
    // GetSourceAttributes() for it to accept the source.
    HRESULT hr = MFCreateAttributes(&m_pSrcAttr, 8);
    if (FAILED(hr)) return hr;

    if (pActivateAttrs) {
        pActivateAttrs->CopyAllItems(m_pSrcAttr);
        LogMsg("Initialize: copied activate attributes to source attributes");
    }

    // Overlay our specific attributes (won't overwrite if already correct)
    m_pSrcAttr->SetGUID(MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE,
                        MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID);
    m_pSrcAttr->SetUINT32(MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_HW_SOURCE, 0);
    // Copy of activate attr; ensure the associated camera flag remains enabled
    m_pSrcAttr->SetUINT32(MF_VIRTUALCAMERA_PROVIDE_ASSOCIATED_CAMERA_SOURCES, 1);
    m_pSrcAttr->SetString(MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME, L"BridgeCam Source");

    // Sensor Profile Collection is MANDATORY for Frame Server virtual cameras
    {
        IMFSensorProfileCollection* pProfileColl = nullptr;
        hr = MFCreateSensorProfileCollection(&pProfileColl);
        if (SUCCEEDED(hr)) {
            IMFSensorProfile* pProfile = nullptr;
            hr = MFCreateSensorProfile(KSCAMERAPROFILE_Legacy, 0, nullptr, &pProfile);
            if (SUCCEEDED(hr)) {
                pProfile->AddProfileFilter(0, L"((RES==;FRT<=30,1;SUT==))");
                pProfileColl->AddProfile(pProfile);
                pProfile->Release();
            }
            m_pSrcAttr->SetUnknown(MF_DEVICEMFT_SENSORPROFILE_COLLECTION, pProfileColl);
            pProfileColl->Release();
            LogMsg("Initialize: added SensorProfileCollection to source attrs");
        }
    }

    // ── 2. Create event queue ──
    hr = MFCreateEventQueue(&m_pEventQueue);
    if (FAILED(hr)) return hr;

    // ── 2b. Create free-threaded marshaler ──
    // Windows Camera Frame Server may access the source from a different
    // apartment; the FTM allows direct cross-apartment access, matching
    // winrt::implements<> + winrt::free_threaded_marshaller behaviour.
    CoCreateFreeThreadedMarshaler(
        static_cast<IUnknown*>(static_cast<IMFMediaSourceEx*>(this)),
        &m_pFTM);
    if (m_pFTM) LogMsg("Initialize: created free-threaded marshaler");

    // Note: the DLL runs inside the consumer app's process (same user session as
    // Tauri).  We do NOT create the SHM here — Tauri creates Local\
    // BridgeCamFrameBuffer and we open it read-only in EnsureMapping().

    // Advertise a handful of common resolutions in two pixel formats.  Some
    // consumers (ffmpeg, NVB) request YUY2; others can handle NV12.  We create
    // a flat list of (width,height,subtype) tuples so MF can choose freely.
    struct Format { UINT32 w, h; GUID subtype; };
    static const Format kFmts[] = {
        {1920,1080, MFVideoFormat_NV12},
        {1920,1080, MFVideoFormat_YUY2},
        {1280,720,  MFVideoFormat_NV12},
        {1280,720,  MFVideoFormat_YUY2},
        {640,360,   MFVideoFormat_NV12},
        {640,360,   MFVideoFormat_YUY2},
    };
    const UINT nFmts = ARRAYSIZE(kFmts);
    IMFMediaType** pTypes = new IMFMediaType*[nFmts];
    for (UINT i = 0; i < nFmts; i++) {
        hr = BuildMediaType(kFmts[i].w, kFmts[i].h, kFmts[i].subtype, &pTypes[i]);
        if (FAILED(hr)) {
            for (UINT j = 0; j < i; j++) pTypes[j]->Release();
            delete [] pTypes;
            return hr;
        }
    }

    IMFStreamDescriptor* pSD = nullptr;
    // Stream ID = 0; must match MF_DEVICESTREAM_STREAM_ID in GetStreamAttributes.
    hr = MFCreateStreamDescriptor(0, nFmts, pTypes, &pSD);
    if (FAILED(hr)) {
        for (UINT i = 0; i < nFmts; i++) pTypes[i]->Release();
        delete [] pTypes;
        return hr;
    }

    // CRITICAL: Set a current media type on the type handler.
    {
        IMFMediaTypeHandler* pHandler = nullptr;
        hr = pSD->GetMediaTypeHandler(&pHandler);
        if (SUCCEEDED(hr)) {
            pHandler->SetCurrentMediaType(pTypes[0]); // default 1920x1080 NV12 — NVB always selects this
            pHandler->Release();
        }
    }
    for (UINT i = 0; i < nFmts; i++) pTypes[i]->Release();
    delete [] pTypes;

    // Set attributes on the StreamDescriptor (same pattern as MS sample
    // _SetStreamDescriptorAttributes).
    pSD->SetUINT32(MF_DEVICESTREAM_STREAM_ID, 0);
    pSD->SetGUID(MF_DEVICESTREAM_STREAM_CATEGORY, PINNAME_VIDEO_CAPTURE);
    pSD->SetUINT32(MF_DEVICESTREAM_FRAMESERVER_SHARED, 1);
    pSD->SetUINT32(MF_DEVICESTREAM_ATTRIBUTE_FRAMESOURCE_TYPES,
                   MFFrameSourceTypes::MFFrameSourceTypes_Color);
    // Note: NOT setting MF_DEVICESTREAM_MAX_FRAME_BUFFERS — not in MS sample.

    // Create a SEPARATE stream attributes store for GetStreamAttributes().
    // MS sample (SimpleMediaSource) returns m_spAttributes (plain IMFAttributes),
    // NOT the stream descriptor.  This avoids Frame Server QI-ing the returned
    // object for IMFStreamDescriptor and potentially mis-handling it.
    if (m_pStreamAttrs) { m_pStreamAttrs->Release(); m_pStreamAttrs = nullptr; }
    hr = MFCreateAttributes(&m_pStreamAttrs, 8);
    if (FAILED(hr)) { pSD->Release(); return hr; }
    m_pStreamAttrs->SetGUID(MF_DEVICESTREAM_STREAM_CATEGORY, PINNAME_VIDEO_CAPTURE);
    m_pStreamAttrs->SetUINT32(MF_DEVICESTREAM_STREAM_ID, 0);
    m_pStreamAttrs->SetUINT32(MF_DEVICESTREAM_FRAMESERVER_SHARED, 1);
    m_pStreamAttrs->SetUINT32(MF_DEVICESTREAM_ATTRIBUTE_FRAMESOURCE_TYPES,
                              MFFrameSourceTypes::MFFrameSourceTypes_Color);
    LogMsg("Initialize: set attributes on SD + created separate stream attrs store");

    // Keep a reference to the SD (passed to PD + stream below).
    m_pStreamSD = pSD; m_pStreamSD->AddRef();

    hr = MFCreatePresentationDescriptor(1, &pSD, &m_pPD);
    // Pre-select stream 0 so Frame Server sees a usable stream in the PD
    if (SUCCEEDED(hr)) m_pPD->SelectStream(0);

    m_pStream = new(std::nothrow) CBridgeCamMFStream();
    if (!m_pStream) { pSD->Release(); return E_OUTOFMEMORY; }
    hr = m_pStream->Init(this, pSD);

    // ── Diagnostic: dump all source attributes ──
    if (m_pSrcAttr) {
        UINT32 count = 0;
        m_pSrcAttr->GetCount(&count);
        char buf[256];
        StringCchPrintfA(buf, 256, "Initialize: source attrs count = %u", count);
        LogMsg(buf);
        for (UINT32 i = 0; i < count && i < 30; i++) {
            GUID key; PROPVARIANT val; PropVariantInit(&val);
            if (SUCCEEDED(m_pSrcAttr->GetItemByIndex(i, &key, &val))) {
                OLECHAR gs[40] = {};
                StringFromGUID2(key, gs, ARRAYSIZE(gs));
                StringCchPrintfA(buf, 256, "  attr[%u]: {%ls} type=%d", i, gs, (int)val.vt);
                LogMsg(buf);
                PropVariantClear(&val);
            }
        }
    }

    // ── Diagnostic: dump stream descriptor attrs ──
    if (pSD) {
        UINT32 count = 0;
        pSD->GetCount(&count);
        char buf[256];
        StringCchPrintfA(buf, 256, "Initialize: SD attrs count = %u", count);
        LogMsg(buf);
    }

    // ── Diagnostic: PD state ──
    if (m_pPD) {
        DWORD sdCount = 0;
        m_pPD->GetStreamDescriptorCount(&sdCount);
        char buf[128];
        StringCchPrintfA(buf, 128, "Initialize: PD stream count = %lu", sdCount);
        LogMsg(buf);
        for (DWORD i = 0; i < sdCount; i++) {
            BOOL sel = FALSE; IMFStreamDescriptor* sd2 = nullptr;
            m_pPD->GetStreamDescriptorByIndex(i, &sel, &sd2);
            StringCchPrintfA(buf, 128, "  PD stream[%lu]: selected=%d", i, (int)sel);
            LogMsg(buf);
            if (sd2) sd2->Release();
        }
    }

    pSD->Release(); return hr;
}

HRESULT CBridgeCamMFSource::BuildMediaType(UINT32 w, UINT32 h, const GUID& subtype, IMFMediaType** pp)
{
    IMFMediaType* t = nullptr; HRESULT hr = MFCreateMediaType(&t); if (FAILED(hr)) return hr;
    t->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
    t->SetGUID(MF_MT_SUBTYPE, subtype);
    t->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
    t->SetUINT32(MF_MT_ALL_SAMPLES_INDEPENDENT, TRUE);
    t->SetUINT32(MF_MT_FIXED_SIZE_SAMPLES, TRUE);
    MFSetAttributeSize(t, MF_MT_FRAME_SIZE, w, h);
    MFSetAttributeRatio(t, MF_MT_FRAME_RATE, kFPS_N, kFPS_D);
    MFSetAttributeRatio(t, MF_MT_PIXEL_ASPECT_RATIO, 1, 1);
    // Color space — required by NVB's AI pipeline for both NV12 and YUY2
    t->SetUINT32(MF_MT_YUV_MATRIX,         MFVideoTransferMatrix_BT601);
    t->SetUINT32(MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_0_255);
    t->SetUINT32(MF_MT_VIDEO_PRIMARIES,     MFVideoPrimaries_BT709);
    if (subtype == MFVideoFormat_NV12) {
        t->SetUINT32(MF_MT_DEFAULT_STRIDE, w);
        t->SetUINT32(MF_MT_SAMPLE_SIZE, w * h * 3 / 2);
    } else if (subtype == MFVideoFormat_YUY2) {
        t->SetUINT32(MF_MT_DEFAULT_STRIDE, w * 2);
        t->SetUINT32(MF_MT_SAMPLE_SIZE, w * h * 2);
    }
    *pp = t; return S_OK;
}

STDMETHODIMP CBridgeCamMFSource::Start(IMFPresentationDescriptor*,const GUID*,const PROPVARIANT*)
{
    LogMsg("Source::Start called");
    if (!m_pEventQueue || !m_pStream) {
        LogMsg("Source::Start -> ERROR: source was shut down (null queue or stream)");
        return MF_E_SHUTDOWN;
    }
    bool wasStarted = (m_state == STATE_STARTED);
    m_state = STATE_STARTED;
    if (m_pStream) m_pStream->SetActive(true);

    // Pass Frame Server's allocator to stream and initialize it
    if (m_pStream) {
        if (m_pProvidedAlloc) {
            m_pStream->SetSampleAllocator(m_pProvidedAlloc);
        }
        HRESULT hrAlloc = m_pStream->InitSampleAllocator();
        char abuf[128]; StringCchPrintfA(abuf, 128,
            "Source::Start -> InitSampleAllocator hr=0x%08lX", (unsigned long)hrAlloc);
        LogMsg(abuf);
    }

    // The Media Foundation pipeline REQUIRES MENewStream (first start) or
    // MEUpdatedStream (restart) with the IMFMediaStream as the event value.
    // Without this, the pipeline never discovers our stream and never calls
    // RequestSample — resulting in a permanent black screen.
    PROPVARIANT varStream;
    PropVariantInit(&varStream);
    varStream.vt = VT_UNKNOWN;
    varStream.punkVal = static_cast<IMFMediaStream*>(m_pStream);
    varStream.punkVal->AddRef();

    if (wasStarted) {
        m_pEventQueue->QueueEventParamVar(MEUpdatedStream, GUID_NULL, S_OK, &varStream);
        LogMsg("Source::Start -> queued MEUpdatedStream");
    } else {
        m_pEventQueue->QueueEventParamVar(MENewStream, GUID_NULL, S_OK, &varStream);
        LogMsg("Source::Start -> queued MENewStream");
    }
    PropVariantClear(&varStream);

    PROPVARIANT v; PropVariantInit(&v);
    m_pEventQueue->QueueEventParamVar(MESourceStarted, GUID_NULL, S_OK, &v);
    if (m_pStream) m_pStream->QueueEvent(MEStreamStarted, GUID_NULL, S_OK, &v);
    LogMsg("Source::Start -> queued MESourceStarted + MEStreamStarted");
    return S_OK;
}
STDMETHODIMP CBridgeCamMFSource::Stop()
{
    m_state = STATE_STOPPED;
    if (m_pStream) { m_pStream->SetActive(false); m_pStream->QueueEvent(MEStreamStopped,GUID_NULL,S_OK,nullptr); }
    m_pEventQueue->QueueEventParamVar(MESourceStopped, GUID_NULL, S_OK, nullptr);
    return S_OK;
}
STDMETHODIMP CBridgeCamMFSource::Shutdown()
{
    if (m_pStream) { m_pStream->Shutdown(); m_pStream->Release(); m_pStream=nullptr; }
    if (m_pEventQueue) { m_pEventQueue->Shutdown(); m_pEventQueue->Release(); m_pEventQueue=nullptr; }
    if (m_pPD) { m_pPD->Release(); m_pPD=nullptr; }
    if (m_pSrcAttr) { m_pSrcAttr->Release(); m_pSrcAttr=nullptr; }
    if (m_pStreamSD) { m_pStreamSD->Release(); m_pStreamSD=nullptr; }
    if (m_pStreamAttrs) { m_pStreamAttrs->Release(); m_pStreamAttrs=nullptr; }    if (m_pFTM) { m_pFTM->Release(); m_pFTM = nullptr; }
    if (m_pProvidedAlloc) { m_pProvidedAlloc->Release(); m_pProvidedAlloc = nullptr; }    LogMsg("Source::Shutdown complete");
    return S_OK;
}

// ---------------------------------------------------------------------------
// CBridgeCamMFStream implementation
// ---------------------------------------------------------------------------
HRESULT CBridgeCamMFStream::Init(CBridgeCamMFSource* s, IMFStreamDescriptor* sd)
{
    m_pSrc=s; m_pSD=sd; sd->AddRef();
    return MFCreateEventQueue(&m_pEventQueue);
}
void CBridgeCamMFStream::Shutdown()
{
    m_bShutdown=true; m_bActive=false;
    if (m_pSampAlloc) { m_pSampAlloc->UninitializeSampleAllocator(); m_pSampAlloc->Release(); m_pSampAlloc=nullptr; }
    m_bAllocReady = false;
    if (m_pView) { UnmapViewOfFile(m_pView); m_pView=nullptr; }
    if (m_hMap) { CloseHandle(m_hMap); m_hMap=nullptr; }
    if (m_pEventQueue) { m_pEventQueue->Shutdown(); m_pEventQueue->Release(); m_pEventQueue=nullptr; }
    if (m_pSD) { m_pSD->Release(); m_pSD=nullptr; }
}
STDMETHODIMP CBridgeCamMFStream::RequestSample(IUnknown* tok)
{
    if (m_bShutdown) return MF_E_SHUTDOWN;
    if (!m_bActive)  return MF_E_MEDIA_SOURCE_WRONGSTATE;

    // Sync output dimensions and subtype from the negotiated current media type.
    // Doing this per-sample means we instantly adapt when NVB/FS selects a format.
    if (m_pSD) {
        IMFMediaTypeHandler* pHandler = nullptr;
        if (SUCCEEDED(m_pSD->GetMediaTypeHandler(&pHandler))) {
            IMFMediaType* pCur = nullptr;
            if (SUCCEEDED(pHandler->GetCurrentMediaType(&pCur))) {
                UINT32 w = 0, h = 0;
                MFGetAttributeSize(pCur, MF_MT_FRAME_SIZE, &w, &h);
                GUID sub = GUID_NULL;
                pCur->GetGUID(MF_MT_SUBTYPE, &sub);
                if (w > 0 && h > 0) { m_iW = w; m_iH = h; }
                if (sub != GUID_NULL)  m_subtype = sub;
                pCur->Release();
            }
            pHandler->Release();
        }
    }

    EnsureMapping();

    // ── Wait for a NEW frame before converting ──────────────────────────
    // Without this, Frame Server calls RequestSample in a tight loop and
    // we burn CPU re-converting the same stale RGBA data into NV12/YUY2.
    //
    // Use timeBeginPeriod(1) to get actual 1ms Sleep resolution.
    // Default Windows timer resolution is ~15.6ms, making Sleep(1) useless.
    bool hasView = (m_pView != nullptr);
    if (hasView) {
        volatile const DWORD* hdr = static_cast<volatile const DWORD*>(m_pView);
        DWORD curSeq = hdr[2];
        if (curSeq == m_lastSeq) {
            // Request 1ms timer resolution for accurate sleeping
            timeBeginPeriod(1);
            // Frame hasn't changed — wait for a new one (up to ~34ms = 1 frame at 30fps)
            for (int i = 0; i < 34; i++) {
                Sleep(1);
                if (m_bShutdown || !m_bActive) { timeEndPeriod(1); return MF_E_SHUTDOWN; }
                curSeq = hdr[2];
                if (curSeq != m_lastSeq) break;
            }
            timeEndPeriod(1);
        }
        m_lastSeq = curSeq;
    }

    IMFSample* s = nullptr;
    HRESULT hr = MakeSample(tok, !hasView, &s);
    static LONG sCount = 0;
    LONG n = InterlockedIncrement(&sCount);
    if (n <= 5 || (n % 300) == 0) {
        char buf[192];
        const BYTE* sg = reinterpret_cast<const BYTE*>(&m_subtype);
        StringCchPrintfA(buf, 192,
            "RequestSample #%ld  view=%d  hr=0x%08lX  dim=%ux%u  fmt=%02X%02X%02X%02X  seq=%lu",
            n, (int)hasView, (unsigned long)hr, m_iW, m_iH,
            sg[0], sg[1], sg[2], sg[3], m_lastSeq);
        LogMsg(buf);
    }
    if (FAILED(hr)) return hr;
    hr = m_pEventQueue->QueueEventParamUnk(MEMediaSample, GUID_NULL, S_OK, s);
    s->Release(); return hr;
}
HRESULT CBridgeCamMFStream::MakeSample(IUnknown* tok, bool black, IMFSample** pp)
{
    const UINT32 w = m_iW, h = m_iH;
    const bool isYUY2 = IsEqualGUID(m_subtype, MFVideoFormat_YUY2);

    // --- Allocate a sample with a proper 2D video buffer ---
    IMFSample* s = nullptr;
    HRESULT hr;
    if (m_pSampAlloc) {
        hr = m_pSampAlloc->AllocateSample(&s);
    } else {
        // Fallback: create a sample with a 2D media buffer
        hr = MFCreateSample(&s);
        if (SUCCEEDED(hr)) {
            IMFMediaBuffer* tmp = nullptr;
            DWORD fourcc = isYUY2 ? MFVideoFormat_YUY2.Data1 : MFVideoFormat_NV12.Data1;
            hr = MFCreate2DMediaBuffer(w, h, fourcc, FALSE, &tmp);
            if (SUCCEEDED(hr)) { s->AddBuffer(tmp); tmp->Release(); }
            else { s->Release(); return hr; }
        }
    }
    if (FAILED(hr)) return hr;

    // --- Get the 2D buffer and lock it ---
    IMFMediaBuffer* buf = nullptr;
    hr = s->GetBufferByIndex(0, &buf);
    if (FAILED(hr)) { s->Release(); return hr; }

    IMF2DBuffer* b2d = nullptr;
    hr = buf->QueryInterface(__uuidof(IMF2DBuffer), reinterpret_cast<void**>(&b2d));
    if (FAILED(hr)) { buf->Release(); s->Release(); return hr; }

    BYTE* p = nullptr;
    LONG pitch = 0;
    hr = b2d->Lock2D(&p, &pitch);
    if (FAILED(hr) || !p) { b2d->Release(); buf->Release(); s->Release(); return hr ? hr : E_FAIL; }

    // --- Write frame data using the real pitch/stride ---
    if (black || !m_pView) {
        if (isYUY2) {
            for (UINT32 row = 0; row < h; row++) {
                BYTE* line = p + row * pitch;
                for (UINT32 col = 0; col < w * 2u; col += 4) {
                    line[col]=0; line[col+1]=128; line[col+2]=0; line[col+3]=128;
                }
            }
        } else {
            // NV12 black: Y=0, UV=128
            BYTE* uvPlane = p + pitch * (LONG)h;
            for (UINT32 row = 0; row < h; row++)
                ZeroMemory(p + row * pitch, w);
            for (UINT32 row = 0; row < h / 2; row++)
                memset(uvPlane + row * pitch, 128, w);
        }
    } else {
        // SHM pixel data is RGBA (4 bytes/pixel, R first)
        const BYTE* src = static_cast<const BYTE*>(m_pView) + kHdrSize;
        volatile const DWORD* hdr = static_cast<volatile const DWORD*>(m_pView);
        const UINT32 sw = (hdr[0] > 0 && hdr[0] <= 3840) ? hdr[0] : w;
        const UINT32 sh = (hdr[1] > 0 && hdr[1] <= 2160) ? hdr[1] : h;

        // Bounds-check against actual mapped file size before reading pixels
        const UINT64 requiredBytes = (UINT64)kHdrSize + (UINT64)sw * (UINT64)sh * 4ull;
        if (requiredBytes > m_shmFileSize) {
            b2d->Unlock2D();
            b2d->Release();
            buf->Release();
            s->Release();
            return MakeSample(tok, true, pp);
        }

        // Compute aspect-correct scaled destination rect within output (w x h).
        UINT32 dstW, dstH, offX, offY;
        if ((UINT64)sw * h > (UINT64)sh * w) {
            dstW = w;
            dstH = (UINT32)((UINT64)sh * w / sw);
            dstH &= ~1u;
            if (dstH < 2) dstH = 2;
            if (dstH > h) dstH = h;
            offX = 0;
            offY = ((h - dstH) / 2) & ~1u;
        } else {
            dstH = h;
            dstW = (UINT32)((UINT64)sw * h / sh);
            dstW &= ~1u;
            if (dstW < 2) dstW = 2;
            if (dstW > w) dstW = w;
            offX = ((w - dstW) / 2) & ~1u;
            offY = 0;
        }

        const UINT32 xStep = (UINT32)(((UINT64)sw << 16) / dstW);
        const UINT32 yStep = (UINT32)(((UINT64)sh << 16) / dstH);

        if (isYUY2) {
            // Fill entire frame with black YUY2
            for (UINT32 row = 0; row < h; row++) {
                BYTE* line = p + row * pitch;
                for (UINT32 col = 0; col < w * 2u; col += 4) {
                    line[col]=0; line[col+1]=128; line[col+2]=0; line[col+3]=128;
                }
            }
            // Scale-blit source into destination rect
            UINT32 srcY_fp = 0;  // fixed-point source Y accumulator
            for (UINT32 row = 0; row < dstH; row++) {
                const UINT32 srcRow = srcY_fp >> 16;
                const BYTE* srcRowPtr = src + srcRow * sw * 4;
                BYTE* line = p + (offY + row) * pitch;
                UINT32 srcX_fp = 0;
                UINT32 col = 0;
                for (; col + 1 < dstW; col += 2) {
                    const UINT32 sx0 = srcX_fp >> 16;
                    srcX_fp += xStep;
                    const UINT32 sx1 = srcX_fp >> 16;
                    srcX_fp += xStep;
                    const BYTE* px0 = srcRowPtr + sx0 * 4;
                    const BYTE* px1 = srcRowPtr + sx1 * 4;
                    const UINT32 r0=px0[0],g0=px0[1],b0=px0[2];
                    const UINT32 r1=px1[0],g1=px1[1],b1=px1[2];
                    BYTE y0=(BYTE)((77u*r0+150u*g0+29u*b0)>>8);
                    BYTE y1=(BYTE)((77u*r1+150u*g1+29u*b1)>>8);
                    INT32 rAvg = (INT32)(r0 + r1) >> 1;
                    INT32 gAvg = (INT32)(g0 + g1) >> 1;
                    INT32 bAvg = (INT32)(b0 + b1) >> 1;
                    INT32 u = ((-43 * rAvg - 85 * gAvg + 128 * bAvg) >> 8) + 128;
                    INT32 v = ((128 * rAvg - 107 * gAvg - 21 * bAvg) >> 8) + 128;
                    DWORD off = (offX + col) * 2;
                    line[off]   = y0;
                    line[off+1] = (BYTE)(u < 0 ? 0 : u > 255 ? 255 : u);
                    line[off+2] = y1;
                    line[off+3] = (BYTE)(v < 0 ? 0 : v > 255 ? 255 : v);
                }
                srcY_fp += yStep;
            }
        } else {
            // NV12 — Scaled nearest-neighbor blit
            BYTE* yPlane  = p;
            BYTE* uvPlane = p + pitch * (LONG)h;

            // Fill entire frame with black (Y=0, UV=128)
            for (UINT32 row = 0; row < h; row++)
                ZeroMemory(yPlane + row * pitch, w);
            for (UINT32 row = 0; row < h / 2; row++)
                memset(uvPlane + row * pitch, 128, w);

            // Scale-blit Y plane
            UINT32 srcY_fp = 0;
            for (UINT32 row = 0; row < dstH; row++) {
                const UINT32 srcRow = srcY_fp >> 16;
                const BYTE* srcRowPtr = src + srcRow * sw * 4;
                BYTE* yRow = yPlane + (offY + row) * pitch;

                UINT32 srcX_fp = 0;
                UINT32 col = 0;
                // Process 4 output pixels per iteration
                for (; col + 3 < dstW; col += 4) {
                    const BYTE* px0 = srcRowPtr + (srcX_fp >> 16) * 4; srcX_fp += xStep;
                    const BYTE* px1 = srcRowPtr + (srcX_fp >> 16) * 4; srcX_fp += xStep;
                    const BYTE* px2 = srcRowPtr + (srcX_fp >> 16) * 4; srcX_fp += xStep;
                    const BYTE* px3 = srcRowPtr + (srcX_fp >> 16) * 4; srcX_fp += xStep;
                    yRow[offX+col]   = (BYTE)((77u*px0[0]+150u*px0[1]+29u*px0[2])>>8);
                    yRow[offX+col+1] = (BYTE)((77u*px1[0]+150u*px1[1]+29u*px1[2])>>8);
                    yRow[offX+col+2] = (BYTE)((77u*px2[0]+150u*px2[1]+29u*px2[2])>>8);
                    yRow[offX+col+3] = (BYTE)((77u*px3[0]+150u*px3[1]+29u*px3[2])>>8);
                }
                for (; col < dstW; col++) {
                    const BYTE* px = srcRowPtr + (srcX_fp >> 16) * 4; srcX_fp += xStep;
                    yRow[offX+col] = (BYTE)((77u*px[0]+150u*px[1]+29u*px[2])>>8);
                }
                srcY_fp += yStep;
            }

            // Scale-blit UV plane (2x2 block averaging from scaled source positions)
            const UINT32 uvYStep = yStep * 2;   // step by 2 dst rows = 2 src rows
            const UINT32 uvXStep = xStep * 2;   // step by 2 dst cols = 2 src cols
            UINT32 uvSrcY_fp = 0;
            for (UINT32 uvRow = 0; uvRow < dstH / 2; uvRow++) {
                const UINT32 srcRow0 = uvSrcY_fp >> 16;
                UINT32 srcRow1 = (uvSrcY_fp + yStep) >> 16;
                if (srcRow1 >= sh) srcRow1 = sh - 1;
                const BYTE* srcRowPtr0 = src + srcRow0 * sw * 4;
                const BYTE* srcRowPtr1 = src + srcRow1 * sw * 4;
                BYTE* uvDst = uvPlane + (offY / 2 + uvRow) * pitch;

                UINT32 uvSrcX_fp = 0;
                for (UINT32 uvCol = 0; uvCol < dstW / 2; uvCol++) {
                    const UINT32 sx0 = uvSrcX_fp >> 16;
                    UINT32 sx1 = (uvSrcX_fp + xStep) >> 16;
                    if (sx1 >= sw) sx1 = sw - 1;
                    // Sample 2x2 block from source at scaled positions
                    const BYTE* p00 = srcRowPtr0 + sx0 * 4;
                    const BYTE* p01 = srcRowPtr0 + sx1 * 4;
                    const BYTE* p10 = srcRowPtr1 + sx0 * 4;
                    const BYTE* p11 = srcRowPtr1 + sx1 * 4;
                    INT32 rAvg = ((INT32)p00[0]+p01[0]+p10[0]+p11[0]) >> 2;
                    INT32 gAvg = ((INT32)p00[1]+p01[1]+p10[1]+p11[1]) >> 2;
                    INT32 bAvg = ((INT32)p00[2]+p01[2]+p10[2]+p11[2]) >> 2;
                    INT32 u = ((-43*rAvg - 85*gAvg + 128*bAvg) >> 8) + 128;
                    INT32 v = ((128*rAvg - 107*gAvg - 21*bAvg) >> 8) + 128;
                    uvDst[offX + uvCol*2]     = (BYTE)(u < 0 ? 0 : u > 255 ? 255 : u);
                    uvDst[offX + uvCol*2 + 1] = (BYTE)(v < 0 ? 0 : v > 255 ? 255 : v);
                    uvSrcX_fp += uvXStep;
                }
                uvSrcY_fp += uvYStep;
            }
        }
    }

    b2d->Unlock2D();
    b2d->Release();
    buf->Release();

    // --- Set sample attributes (matching MS SimpleMediaSource pattern) ---
    s->SetSampleTime(MFGetSystemTime());
    s->SetSampleDuration(333333LL);
    s->SetUINT32(MFSampleExtension_CleanPoint, TRUE);
    if (tok) s->SetUnknown(MFSampleExtension_Token, tok);
    *pp = s;
    return S_OK;
}

// ---------------------------------------------------------------------------
// IClassFactory
// ---------------------------------------------------------------------------
class CMFSourceFactory : public IClassFactory {
    LONG m_cRef;
public:
    CMFSourceFactory() : m_cRef(1L) {}
    STDMETHODIMP_(ULONG) AddRef()  { return (ULONG)InterlockedIncrement(&m_cRef); }
    STDMETHODIMP_(ULONG) Release() { ULONG c=(ULONG)InterlockedDecrement(&m_cRef); if(!c) delete this; return c; }
    STDMETHODIMP QueryInterface(REFIID riid, void** ppv) {
        if (!ppv) return E_POINTER;
        if (riid==IID_IUnknown||riid==IID_IClassFactory) { *ppv=this; AddRef(); return S_OK; }
        *ppv=nullptr; return E_NOINTERFACE;
    }
    STDMETHODIMP CreateInstance(IUnknown* outer, REFIID riid, void** ppv) {
        LogQI("Factory::CreateInstance", riid, S_OK);
        if (outer) return CLASS_E_NOAGGREGATION;
        // Frame Server requests IID_IMFActivate; return an Activate object which
        // lazily creates the actual IMFMediaSourceEx when ActivateObject is called.
        CBridgeCamActivate* pAct = new(std::nothrow) CBridgeCamActivate();
        if (!pAct) return E_OUTOFMEMORY;
        HRESULT hr = pAct->QueryInterface(riid, ppv);
        pAct->Release(); return hr;
    }
    STDMETHODIMP LockServer(BOOL) { return S_OK; }
};

// ---------------------------------------------------------------------------
// DLL exports
// ---------------------------------------------------------------------------
STDAPI BridgeCamMF_GetClassObject(REFCLSID rclsid, REFIID riid, void** ppv)
{
    LogQI("DllGetClassObject", riid, S_OK);
    if (rclsid == CLSID_BridgeCamMFSource) {
        CMFSourceFactory* f = new(std::nothrow) CMFSourceFactory();
        if (!f) return E_OUTOFMEMORY;
        HRESULT hr = f->QueryInterface(riid, ppv);
        f->Release(); return hr;
    }
    return CLASS_E_CLASSNOTAVAILABLE;
}

HRESULT RegisterMFSource()
{
    wchar_t dllPath[MAX_PATH] = {};
    if (!GetModuleFileNameW(g_hInst, dllPath, ARRAYSIZE(dllPath)))
        return HRESULT_FROM_WIN32(GetLastError());

    // Lambda: write a reg value; writes to HKCU when called non-elevated
    auto Set = [](HKEY root, const wchar_t* key, const wchar_t* val, const wchar_t* data) -> HRESULT {
        HKEY hk=NULL;
        LSTATUS ls = RegCreateKeyExW(root, key, 0, nullptr, REG_OPTION_NON_VOLATILE, KEY_SET_VALUE, nullptr, &hk, nullptr);
        if (ls!=ERROR_SUCCESS) return HRESULT_FROM_WIN32(ls);
        DWORD cb=(DWORD)((wcslen(data)+1)*sizeof(wchar_t));
        ls = RegSetValueExW(hk, val, 0, REG_SZ, reinterpret_cast<const BYTE*>(data), cb);
        RegCloseKey(hk); return HRESULT_FROM_WIN32(ls);
    };

    wchar_t clsidKey[128], inprocKey[160];
    wchar_t hkcuClsidKey[160], hkcuInprocKey[192];
    swprintf_s(clsidKey,     L"CLSID\\{B9EAAFE1-1234-5678-ABCD-1234567890AB}");
    swprintf_s(inprocKey,    L"%s\\InprocServer32", clsidKey);
    // Frame Server reads CurrentUser virtual cameras from HKCU\Software\Classes\CLSID
    swprintf_s(hkcuClsidKey,  L"Software\\Classes\\CLSID\\{B9EAAFE1-1234-5678-ABCD-1234567890AB}");
    swprintf_s(hkcuInprocKey, L"%s\\InprocServer32", hkcuClsidKey);

    // HKCR write (elevated) — covers HKLM and system-wide COM fallback
    HRESULT hr = Set(HKEY_CLASSES_ROOT, clsidKey,  nullptr,           kFriendlyName);
    if (FAILED(hr)) return hr;
    hr = Set(HKEY_CLASSES_ROOT, inprocKey, nullptr,          dllPath);
    if (FAILED(hr)) return hr;
    hr = Set(HKEY_CLASSES_ROOT, inprocKey, L"ThreadingModel", L"Both");
    if (FAILED(hr)) return hr;

    // HKCU write (works non-elevated) — required by the Windows Camera Frame Server
    // when the virtual camera is registered with MFVirtualCameraType_CurrentUser.
    hr = Set(HKEY_CURRENT_USER, hkcuClsidKey,  nullptr,           kFriendlyName);
    if (FAILED(hr)) return hr;
    hr = Set(HKEY_CURRENT_USER, hkcuInprocKey, nullptr,          dllPath);
    if (FAILED(hr)) return hr;
    return Set(HKEY_CURRENT_USER, hkcuInprocKey, L"ThreadingModel", L"Both");
}

HRESULT UnregisterMFSource()
{
    RegDeleteTreeW(HKEY_CLASSES_ROOT,  L"CLSID\\{B9EAAFE1-1234-5678-ABCD-1234567890AB}");
    RegDeleteTreeW(HKEY_CURRENT_USER,  L"Software\\Classes\\CLSID\\{B9EAAFE1-1234-5678-ABCD-1234567890AB}");
    return S_OK;
}
