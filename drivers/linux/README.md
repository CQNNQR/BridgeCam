# Linux Driver Skeleton

This directory will host helper scripts and binaries for working with
`v4l2loopback`.

Early tasks:

* Provide a shell script (`setup.sh`) that installs the kernel module and
  creates a `/dev/videoX` device named "BridgeCam Source".
* Add a small Rust/C program that opens the device and writes raw YUV frames
  from the desktop app. Communication can happen over a Unix socket or via a
  temporary file produced by the `create_shared_memory` command.

Example `setup.sh` (TODO):

```sh
#!/bin/bash
modprobe v4l2loopback card_label="BridgeCam Source" exclusive_caps=1
```
