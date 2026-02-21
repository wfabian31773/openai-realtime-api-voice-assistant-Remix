{pkgs}: {
  deps = [
    pkgs.rsync
    pkgs.udev
    pkgs.cairo
    pkgs.pango
    pkgs.libxkbcommon
    pkgs.expat
    pkgs.dbus
    pkgs.cups
    pkgs.at-spi2-core
    pkgs.nss
    pkgs.nspr
    pkgs.glib
    pkgs.alsa-lib
    pkgs.mesa
    pkgs.xorg.libXrandr
    pkgs.xorg.libXfixes
    pkgs.xorg.libXext
    pkgs.xorg.libXdamage
    pkgs.xorg.libXcomposite
    pkgs.xorg.libX11
    pkgs.xorg.libxcb
   ];
}
