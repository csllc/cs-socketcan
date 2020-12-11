#!/bin/sh
# 
# Kvaser kernel module build script for Raspberry Pi
# Based on https://gist.github.com/adrienthebo/cd996d9a1098d792bfab7b08ae3700e5#file-rpi-kvaser-usb-sh

set -u
set -e

export RPI_FW_REV=$(zcat /usr/share/doc/raspberrypi-bootloader/changelog.Debian.gz | sed -n '/.*firmware as of [0-9a-fA-F]\+/ {s/.*firmware as of \([0-9a-fA-F]\+\)/\1/;p;q}')
echo "Raspberry Pi 3 Firmware revision: $RPI_FW_REV"

export RPI_LINUX_REV=$(wget https://raw.github.com/raspberrypi/firmware/$RPI_FW_REV/extra/git_hash --quiet -O -)
echo "Raspberry Pi 3 Linux kernel revision: $RPI_LINUX_REV"

if ! [ -d linux-$RPI_LINUX_REV ]; then
    wget https://github.com/raspberrypi/linux/archive/$RPI_LINUX_REV.zip -O linux-$RPI_LINUX_REV.zip
    unzip linux-$RPI_LINUX_REV.zip
fi

cd linux-$RPI_LINUX_REV

if ! [ -f Module.symvers ]; then
    wget https://raw.github.com/raspberrypi/firmware/$RPI_FW_REV/extra/Module7.symvers -O Module.symvers
fi

sudo modprobe configs
zcat /proc/config.gz > .config

make prepare
make modules_prepare

set -x

echo "Editing .config to include kvaser_usb module"
sed -ie '/CONFIG_CAN_KVASER_USB/s/.*/CONFIG_CAN_KVASER_USB=m/' .config

make -j 4 SUBDIRS=scripts/mod
make -j 4 drivers/net/can/usb/kvaser_usb modules
make -j 4 drivers/net/can/usb/kvaser_usb modules_install

sudo cp drivers/net/can/usb/kvaser_usb/kvaser_usb.ko /lib/modules/$(uname -r)/kernel/drivers/staging/
sudo depmod
sudo modprobe kvaser_usb
