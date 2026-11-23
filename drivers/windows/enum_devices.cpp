#include <iostream>
#include <windows.h>
#include <dshow.h>

#pragma comment(lib, "strmiids")

int main()
{
    HRESULT hr = CoInitialize(NULL);
    if (FAILED(hr)) {
        std::cerr << "CoInitialize failed: 0x" << std::hex << hr << "\n";
        return 1;
    }

    ICreateDevEnum *pDevEnum = nullptr;
    hr = CoCreateInstance(CLSID_SystemDeviceEnum, NULL, CLSCTX_INPROC_SERVER,
                          IID_ICreateDevEnum, (void**)&pDevEnum);
    if (FAILED(hr)) {
        std::cerr << "CoCreateInstance(SystemDeviceEnum) failed: 0x" << std::hex << hr << "\n";
        CoUninitialize();
        return 1;
    }

    IEnumMoniker *pEnum = nullptr;
    hr = pDevEnum->CreateClassEnumerator(CLSID_VideoInputDeviceCategory, &pEnum, 0);
    if (hr != S_OK) {
        std::cerr << "No video capture devices found or enumeration failed.\n";
        pDevEnum->Release();
        CoUninitialize();
        return 1;
    }

    IMoniker *pMoniker = nullptr;
    ULONG fetched = 0;
    std::cout << "Video capture devices:" << std::endl;
    while (pEnum->Next(1, &pMoniker, &fetched) == S_OK) {
        IPropertyBag *pPropBag = nullptr;
        hr = pMoniker->BindToStorage(0, 0, IID_IPropertyBag, (void**)&pPropBag);
        if (SUCCEEDED(hr)) {
            VARIANT varName;
            VariantInit(&varName);
            hr = pPropBag->Read(L"FriendlyName", &varName, 0);
            if (SUCCEEDED(hr)) {
                std::wcout << L"  - " << varName.bstrVal << std::endl;
            }
            VariantClear(&varName);
            pPropBag->Release();
        }
        pMoniker->Release();
    }

    pEnum->Release();
    pDevEnum->Release();
    CoUninitialize();
    return 0;
}
