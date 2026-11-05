using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

// Captura la salida (loopback WASAPI) de un dispositivo de audio concreto.
//   EchoLoopback list                 -> "id<TAB>nombre<TAB>1|0 (predeterminado)" por línea
//   EchoLoopback capture <id|default> -> PCM float32 mono a 16 kHz por stdout
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDeviceEnumeratorCom { }

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
    void EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
    void GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
    void GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
    void RegisterEndpointNotificationCallback(IntPtr client);
    void UnregisterEndpointNotificationCallback(IntPtr client);
}

[ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceCollection {
    void GetCount(out int count);
    void Item(int index, out IMMDevice device);
}

[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
    void Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    void OpenPropertyStore(int access, out IPropertyStore props);
    void GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    void GetState(out int state);
}

[ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPropertyStore {
    void GetCount(out int count);
    void GetAt(int index, out PropertyKey key);
    void GetValue(ref PropertyKey key, out PropVariant value);
    void SetValue(ref PropertyKey key, ref PropVariant value);
    void Commit();
}

[ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioClient {
    void Initialize(int shareMode, int streamFlags, long bufferDuration, long periodicity, IntPtr format, ref Guid sessionGuid);
    void GetBufferSize(out uint frames);
    void GetStreamLatency(out long latency);
    void GetCurrentPadding(out uint frames);
    void IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
    void GetMixFormat(out IntPtr format);
    void GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
    void Start();
    void Stop();
    void Reset();
    void SetEventHandle(IntPtr handle);
    void GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
}

[ComImport, Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioCaptureClient {
    void GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong qpcPosition);
    void ReleaseBuffer(uint frames);
    void GetNextPacketSize(out uint frames);
}

[StructLayout(LayoutKind.Sequential)]
struct PropertyKey {
    public Guid fmtid;
    public uint pid;
}

// 24 bytes en x64, como el PROPVARIANT nativo.
[StructLayout(LayoutKind.Explicit, Size = 24)]
struct PropVariant {
    [FieldOffset(0)] public ushort vt;
    [FieldOffset(8)] public IntPtr ptr;
}

static class Program {
    const int OutRate = 16000;

    [DllImport("ole32.dll")]
    static extern int PropVariantClear(ref PropVariant pv);

    static int Main(string[] args) {
        try {
            if (args.Length >= 1 && args[0] == "list") return List();
            if (args.Length >= 2 && args[0] == "capture") return Capture(args[1]);
            Console.Error.WriteLine("uso: EchoLoopback list | capture <id|default>");
            return 2;
        } catch (Exception e) {
            Console.Error.WriteLine(e.Message);
            return 1;
        }
    }

    static string FriendlyName(IMMDevice dev) {
        IPropertyStore ps;
        dev.OpenPropertyStore(0, out ps);
        PropertyKey key = new PropertyKey();
        key.fmtid = new Guid("A45C254E-DF1C-4EFD-8020-67D146A850E0");
        key.pid = 14;
        PropVariant pv;
        ps.GetValue(ref key, out pv);
        string name = pv.vt == 31 ? Marshal.PtrToStringUni(pv.ptr) : "";
        PropVariantClear(ref pv);
        return name ?? "";
    }

    static int List() {
        IMMDeviceEnumerator en = (IMMDeviceEnumerator)new MMDeviceEnumeratorCom();
        string defaultId = "";
        try {
            IMMDevice def;
            en.GetDefaultAudioEndpoint(0, 1, out def);
            def.GetId(out defaultId);
        } catch (Exception) { }

        IMMDeviceCollection coll;
        en.EnumAudioEndpoints(0, 1, out coll);
        int n;
        coll.GetCount(out n);
        StreamWriter w = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
        for (int i = 0; i < n; i++) {
            IMMDevice d;
            coll.Item(i, out d);
            string id;
            d.GetId(out id);
            w.Write(id + "\t" + FriendlyName(d).Replace('\t', ' ') + "\t" + (id == defaultId ? "1" : "0") + "\n");
        }
        w.Flush();
        return 0;
    }

    static float ReadSample(byte[] buf, int offset, int bits, bool isFloat) {
        if (isFloat) return BitConverter.ToSingle(buf, offset);
        if (bits == 16) return BitConverter.ToInt16(buf, offset) / 32768f;
        if (bits == 24) return (((buf[offset + 2] << 24) | (buf[offset + 1] << 16) | (buf[offset] << 8)) >> 8) / 8388608f;
        return BitConverter.ToInt32(buf, offset) / 2147483648f;
    }

    static void Flush(Stream stdout, float[] samples, int count) {
        if (count == 0) return;
        byte[] bytes = new byte[count * 4];
        Buffer.BlockCopy(samples, 0, bytes, 0, bytes.Length);
        stdout.Write(bytes, 0, bytes.Length);
        stdout.Flush();
    }

    static int Capture(string id) {
        // Termina si Electron cierra el pipe de entrada (la app se cerró).
        Thread watcher = new Thread(delegate () {
            Stream stdin = Console.OpenStandardInput();
            byte[] b = new byte[64];
            while (stdin.Read(b, 0, b.Length) > 0) { }
            Environment.Exit(0);
        });
        watcher.IsBackground = true;
        watcher.Start();

        IMMDeviceEnumerator en = (IMMDeviceEnumerator)new MMDeviceEnumeratorCom();
        IMMDevice dev;
        if (id == "default") en.GetDefaultAudioEndpoint(0, 1, out dev);
        else en.GetDevice(id, out dev);

        Guid iidClient = new Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2");
        object o;
        dev.Activate(ref iidClient, 23, IntPtr.Zero, out o);
        IAudioClient client = (IAudioClient)o;

        IntPtr fmt;
        client.GetMixFormat(out fmt);
        int tag = Marshal.ReadInt16(fmt, 0) & 0xFFFF;
        int channels = Marshal.ReadInt16(fmt, 2);
        int rate = Marshal.ReadInt32(fmt, 4);
        int blockAlign = Marshal.ReadInt16(fmt, 12);
        int bits = Marshal.ReadInt16(fmt, 14);
        bool isFloat = tag == 3;
        if (tag == 0xFFFE) isFloat = Marshal.ReadInt32(fmt, 24) == 3;
        int bytesPer = bits / 8;

        Guid session = Guid.Empty;
        // 0x00020000 = AUDCLNT_STREAMFLAGS_LOOPBACK
        client.Initialize(0, 0x00020000, 10000000L, 0L, fmt, ref session);
        Guid iidCap = new Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317");
        object c;
        client.GetService(ref iidCap, out c);
        IAudioCaptureClient cap = (IAudioCaptureClient)c;
        client.Start();

        Stream stdout = Console.OpenStandardOutput();
        float[] outBuf = new float[16384];
        int outN = 0;
        long emitted = 0;
        int phase = 0;
        double sum = 0;
        int cnt = 0;
        byte[] packet = new byte[0];
        Stopwatch clock = Stopwatch.StartNew();

        while (true) {
            bool gotData = false;
            uint pkt;
            cap.GetNextPacketSize(out pkt);
            while (pkt > 0) {
                IntPtr data;
                uint frames, flags;
                ulong devPos, qpcPos;
                cap.GetBuffer(out data, out frames, out flags, out devPos, out qpcPos);
                int size = (int)frames * blockAlign;
                bool silent = (flags & 2) != 0;
                if (!silent) {
                    if (packet.Length < size) packet = new byte[size];
                    Marshal.Copy(data, packet, 0, size);
                }
                for (int i = 0; i < (int)frames; i++) {
                    float mono = 0;
                    if (!silent) {
                        for (int ch = 0; ch < channels; ch++) mono += ReadSample(packet, i * blockAlign + ch * bytesPer, bits, isFloat);
                        mono /= channels;
                    }
                    // Promedia las muestras de entrada para bajar a 16 kHz.
                    sum += mono;
                    cnt++;
                    phase += OutRate;
                    if (phase >= rate) {
                        phase -= rate;
                        outBuf[outN++] = (float)(sum / cnt);
                        sum = 0;
                        cnt = 0;
                        if (outN == outBuf.Length) { Flush(stdout, outBuf, outN); emitted += outN; outN = 0; }
                    }
                }
                cap.ReleaseBuffer(frames);
                gotData = true;
                cap.GetNextPacketSize(out pkt);
            }
            Flush(stdout, outBuf, outN);
            emitted += outN;
            outN = 0;

            // WASAPI no entrega paquetes mientras no suena nada: se rellena con silencio para que el reloj siga.
            if (!gotData) {
                long deficit = clock.ElapsedMilliseconds * OutRate / 1000 - emitted;
                if (deficit >= 160) {
                    if (deficit > OutRate) deficit = OutRate;
                    Flush(stdout, new float[deficit], (int)deficit);
                    emitted += deficit;
                }
            }
            Thread.Sleep(10);
        }
    }
}
