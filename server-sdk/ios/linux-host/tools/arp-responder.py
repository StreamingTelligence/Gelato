#!/usr/bin/env python3
import argparse
import sys

from scapy.all import ARP, Ether, get_if_hwaddr, sendp, sniff


def main() -> int:
    parser = argparse.ArgumentParser(description="Reply to ARP requests for one IPv4 address.")
    parser.add_argument("--iface", required=True)
    parser.add_argument("--ip", required=True)
    parser.add_argument("--mac")
    args = parser.parse_args()

    mac = args.mac or get_if_hwaddr(args.iface)
    print(f"READY arp-responder iface={args.iface} ip={args.ip} mac={mac}", flush=True)

    def handle(packet):
        if not packet.haslayer(ARP) or not packet.haslayer(Ether):
            return
        arp = packet[ARP]
        if arp.op != 1 or arp.pdst != args.ip:
            return
        reply = (
            Ether(src=mac, dst=packet[Ether].src)
            / ARP(op=2, hwsrc=mac, psrc=args.ip, hwdst=arp.hwsrc, pdst=arp.psrc)
        )
        sendp(reply, iface=args.iface, verbose=False)
        print(f"reply {args.ip} is-at {mac} to {arp.psrc} {arp.hwsrc}", flush=True)

    sniff(iface=args.iface, filter=f"arp and arp dst host {args.ip}", prn=handle, store=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
