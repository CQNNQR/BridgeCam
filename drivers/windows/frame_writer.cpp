// frame_writer.cpp
// Simple utility to open the Global shared-memory object created by BridgeCam
// and repeatedly write a moving color bar pattern.  Useful to verify whether
// Frame Server (and apps like NVB) can see actual frames when the virtual
// camera is active.

#include <windows.h>
#include <iostream>
#include <chrono>
#include <thread>

int main(int argc, char** argv)
{
    // Use a file in ProgramData — accessible from both Session 0 (Frame Server)
    // and Session 1 (user apps).  No Local\ / Global\ naming games.
    const char* filePath = "C:\\ProgramData\\BridgeCam\\framebuffer.dat";
    const SIZE_T maxBytes = 3840ull * 2160ull * 4ull + 12ull;

    std::cout << "Creating file-backed SHM at '" << filePath << "'...\n";
    CreateDirectoryA("C:\\ProgramData\\BridgeCam", nullptr); // ignore if exists

    HANDLE hFile = CreateFileA(filePath, GENERIC_READ|GENERIC_WRITE,
                               FILE_SHARE_READ|FILE_SHARE_WRITE,
                               nullptr, CREATE_ALWAYS,
                               FILE_ATTRIBUTE_NORMAL, nullptr);
    if (hFile == INVALID_HANDLE_VALUE) {
        std::cerr << "CreateFile failed: " << GetLastError() << "\n";
        return 1;
    }
    // Pre-allocate the file to maxBytes so MapViewOfFile covers the whole buffer
    LARGE_INTEGER sz; sz.QuadPart = (LONGLONG)maxBytes;
    SetFilePointerEx(hFile, sz, nullptr, FILE_BEGIN);
    SetEndOfFile(hFile);

    HANDLE hMap = CreateFileMappingA(hFile, nullptr, PAGE_READWRITE,
                                     (DWORD)((maxBytes >> 32) & 0xFFFFFFFF),
                                     (DWORD)(maxBytes & 0xFFFFFFFF), nullptr);
    CloseHandle(hFile);
    if (!hMap) {
        std::cerr << "CreateFileMapping failed: " << GetLastError() << "\n";
        return 1;
    }
    std::cout << "File-backed mapping created\n";
    {
        // initialize header to some default dimension (e.g. 1280x720)
        LPVOID tmp = MapViewOfFile(hMap, FILE_MAP_WRITE, 0, 0, 12);
        if (tmp) {
            DWORD *hdr = reinterpret_cast<DWORD*>(tmp);
            hdr[0] = 1280;
            hdr[1] = 720;
            hdr[2] = 0;
            UnmapViewOfFile(tmp);
        }
    }
    LPVOID view = MapViewOfFile(hMap, FILE_MAP_WRITE, 0, 0, 0);
    if (!view) {
        std::cerr << "MapViewOfFile failed: " << GetLastError() << "\n";
        CloseHandle(hMap);
        return 1;
    }
    std::cout << "Mapping opened. Will write RGBA test pattern until Ctrl-C.\n";
    std::cout << "  (MakeSample in the DLL converts RGBA -> NV12 for consumers)\n";

    // header: width(u32), height(u32), seq(u32)
    // pixel data: RGBA, 4 bytes per pixel, starting at byte 12
    while (true) {
        // read the current header to know dimensions
        DWORD* hdr = reinterpret_cast<DWORD*>(view);
        UINT32 w = hdr[0];
        UINT32 h = hdr[1];
        if (w == 0 || h == 0) {
            std::this_thread::sleep_for(std::chrono::milliseconds(200));
            continue;
        }
        DWORD seq = hdr[2];
        BYTE* base = reinterpret_cast<BYTE*>(view);
        BYTE* pixels = base + 12;  // RGBA pixel data

        // Write a cycling color bar pattern in RGBA:
        // Vertical bars that shift hue each frame so you can see motion.
        BYTE phase = (BYTE)(seq & 0xFF);
        for (UINT32 row = 0; row < h; row++) {
            for (UINT32 col = 0; col < w; col++) {
                BYTE* px = pixels + (row * w + col) * 4;
                // Create 8 vertical color bars with a shifting brightness
                BYTE bar = (BYTE)((col * 8 / w) & 7);
                BYTE luma = (BYTE)(((col + phase * 4) * 3) & 0xFF);
                switch (bar) {
                    case 0: px[0]=luma; px[1]=0;    px[2]=0;    break; // Red
                    case 1: px[0]=0;    px[1]=luma; px[2]=0;    break; // Green
                    case 2: px[0]=0;    px[1]=0;    px[2]=luma; break; // Blue
                    case 3: px[0]=luma; px[1]=luma; px[2]=0;    break; // Yellow
                    case 4: px[0]=luma; px[1]=0;    px[2]=luma; break; // Magenta
                    case 5: px[0]=0;    px[1]=luma; px[2]=luma; break; // Cyan
                    case 6: px[0]=luma; px[1]=luma; px[2]=luma; break; // White
                    case 7: px[0]=64;   px[1]=64;   px[2]=64;   break; // Grey
                }
                px[3] = 255; // Alpha
            }
        }
        hdr[2] = seq + 1;
        std::this_thread::sleep_for(std::chrono::milliseconds(33));
    }

    UnmapViewOfFile(view);
    CloseHandle(hMap);
    return 0;
}
