# Tablet installer

The host-side `weft` CLI uses SSH to install, check, link, and uninstall the tablet daemon.

```sh
weft setup --host root@10.11.99.1
weft doctor --host root@10.11.99.1
weft uninstall --host root@10.11.99.1
```

Use the web setup page for the install command when you also want to link
the tablet to a relay. `weft setup` installs under `/home/root/weft`, checks
firmware compatibility, and sets up the service to take over tablet sync.
By default it installs a boot guard; use `--no-auto-reinstall` to opt out
of that boot-time restoration. The default editor store timeout is 500 ms.

`weft uninstall` removes the service and editor overrides and attempts to
restore stock sync. It leaves the files under `/home/root/weft` in place.
Check the tablet after uninstalling to confirm stock sync resumed.
