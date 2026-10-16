"""Read kernel-denied destinations using libnetfilter_log, without packet payload logs."""

import ctypes
import ctypes.util
import ipaddress
import os
import socket
import struct


def destination_packet(packet):
    if not packet:
        return {}
    version = packet[0] >> 4
    if version == 4 and len(packet) >= 20:
        protocol, offset, address = packet[9], (packet[0] & 15) * 4, str(ipaddress.ip_address(bytes(packet[16:20])))
    elif version == 6 and len(packet) >= 40:
        protocol, offset, address = packet[6], 40, str(ipaddress.ip_address(bytes(packet[24:40])))
    else:
        return {}
    result = {"ip": address, "protocol": protocol}
    if protocol in (6, 17) and len(packet) >= offset + 4:
        result["port"] = struct.unpack_from("!H", packet, offset + 2)[0]
    return result


class PacketLog:
    def __init__(self, audit):
        self.audit = audit
        self.failure = None
        self.lib = ctypes.CDLL(ctypes.util.find_library("netfilter_log"), use_errno=True)
        pointer = ctypes.c_void_p
        declarations = {
            "nflog_open": (pointer, []), "nflog_close": (ctypes.c_int, [pointer]),
            "nflog_bind_pf": (ctypes.c_int, [pointer, ctypes.c_uint16]),
            "nflog_bind_group": (pointer, [pointer, ctypes.c_uint16]),
            "nflog_set_mode": (ctypes.c_int, [pointer, ctypes.c_uint8, ctypes.c_uint32]),
            "nflog_set_qthresh": (ctypes.c_int, [pointer, ctypes.c_uint32]),
            "nflog_set_timeout": (ctypes.c_int, [pointer, ctypes.c_uint32]),
            "nflog_fd": (ctypes.c_int, [pointer]),
            "nflog_handle_packet": (ctypes.c_int, [pointer, pointer, ctypes.c_int]),
            "nflog_get_payload": (ctypes.c_int, [pointer, ctypes.POINTER(pointer)]),
        }
        for name, (restype, args) in declarations.items():
            function = getattr(self.lib, name)
            function.restype, function.argtypes = restype, args
        self.handle = self.lib.nflog_open()
        if not self.handle:
            raise OSError(ctypes.get_errno(), "cannot open NFLOG")
        for family in (socket.AF_INET, socket.AF_INET6):
            if self.lib.nflog_bind_pf(self.handle, family) < 0:
                self.lib.nflog_close(self.handle)
                raise OSError(ctypes.get_errno(), "cannot bind kernel denial address family")
        group = self.lib.nflog_bind_group(self.handle, 100)
        if not group or self.lib.nflog_set_mode(group, 2, 128) < 0 or self.lib.nflog_set_qthresh(group, 1) < 0 or self.lib.nflog_set_timeout(group, 1) < 0:
            self.lib.nflog_close(self.handle)
            raise OSError(ctypes.get_errno(), "cannot subscribe to scope denials")
        callback_type = ctypes.CFUNCTYPE(ctypes.c_int, pointer, pointer, pointer, pointer)

        def callback(_group, _message, data, _user):
            try:
                payload = pointer()
                size = self.lib.nflog_get_payload(data, ctypes.byref(payload))
                if size > 0:
                    self.audit("denied", transport="kernel", **destination_packet(ctypes.string_at(payload, size)))
                return 0
            except BaseException as error:
                # ctypes cannot propagate a Python exception through the C callback.
                self.failure = error
                return -1

        self.callback = callback_type(callback)
        self.lib.nflog_callback_register.argtypes = [pointer, callback_type, pointer]
        self.lib.nflog_callback_register.restype = ctypes.c_int
        if self.lib.nflog_callback_register(group, self.callback, None) < 0:
            self.lib.nflog_close(self.handle)
            raise OSError("cannot register packet logging callback")
        self.socket = socket.socket(fileno=os.dup(self.lib.nflog_fd(self.handle)))

    def run(self):
        while True:
            packet = self.socket.recv(65536)
            if not packet:
                raise OSError("kernel denial stream closed")
            result = self.lib.nflog_handle_packet(self.handle, ctypes.create_string_buffer(packet), len(packet))
            if self.failure is not None:
                raise self.failure
            if result < 0:
                raise OSError(ctypes.get_errno(), "cannot read kernel denial stream")
