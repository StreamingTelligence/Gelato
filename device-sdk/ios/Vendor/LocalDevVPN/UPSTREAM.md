# LocalDevVPN upstream component

Mobile Agent uses the packet recycling algorithm from
[jkcoxson/LocalDevVPN](https://github.com/jkcoxson/LocalDevVPN), pinned from
commit `02efcfe72f18b6d14f4e36178911c74265ddcaca`.

The adapted component lives at
`PacketTunnel/LocalDevVPNPacketRecycler.swift`. Mobile Agent retains the
upstream `10.7.0.0`/`10.7.0.1` packet translation and network settings while
integrating it with the project's Linux packet transport and lifecycle.
