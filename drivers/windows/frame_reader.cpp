// frame_reader.cpp
// Simple utility to open a shared-memory file created by BridgeCam desktop
// and report its size. This demonstrates how the Windows driver or a test
// harness can access the buffer produced by the Tauri application.

#include <iostream>
#include <fstream>
#include <vector>

int main(int argc, char** argv) {
    if (argc < 2) {
        std::cerr << "Usage: frame_reader <shm_path>\n";
        return 1;
    }
    std::string path = argv[1];
    std::ifstream f(path, std::ios::binary);
    if (!f) {
        std::cerr << "Failed to open shared memory file: " << path << "\n";
        return 1;
    }
    f.seekg(0, std::ios::end);
    std::streamsize size = f.tellg();
    f.seekg(0, std::ios::beg);
    std::vector<char> buf(size);
    if (size > 0) {
        f.read(buf.data(), size);
    }
    std::cout << "Read " << size << " bytes from " << path << "\n";
    return 0;
}
