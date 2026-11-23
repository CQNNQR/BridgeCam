#!/bin/bash
# Simple setup script for v4l2loopback device named BridgeCam Source
# Requires sudo privileges.

modprobe v4l2loopback card_label="BridgeCam Source" exclusive_caps=1

echo "Loaded v4l2loopback. Device should appear as /dev/videoX with label 'BridgeCam Source'"
