// BridgeCamExtension.m
// Minimal CoreMediaIO Camera Extension skeleton.
// See https://developer.apple.com/documentation/coremediaio/camera-extensions
// for details. The real extension must subclass CMIO::PlugIn and implement
// required plug-in entry points.  Here we merely lay out placeholders.

#import <Foundation/Foundation.h>
#import <CoreMediaIO/CMIOHardwarePlugIn.h>

// GUID for our virtual device (example, replace later)
// {B9EAAFE0-1234-5678-ABCD-1234567890AB}
static const CMIOObjectPropertyAddress kBridgeCamDeviceProperty = {
    kCMIOObjectPropertySelectorGlobal, kCMIOObjectPropertyScopeGlobal, kCMIOObjectPropertyElementMaster
};

// Plugin entry points
OSStatus CMIOHardwarePlugInFactory(CFAllocatorRef allocator, CFUUIDRef typeUUID, void **plugInOut) {
    // implementation would return a pointer to our plug-in object
    return kCMIOHardwarePlugInNoError;
}

@implementation BridgeCamExtension

// Add methods for device enumeration, stream management, and frame delivery
// which will open the shared memory file written by the desktop client.

@end
