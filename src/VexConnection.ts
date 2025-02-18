import {
  AckType,
  FileDownloadTarget,
  FileExitAction,
  FileInitAction,
  FileInitOption,
  FileLoadAction,
  FileVendor,
  type IFileBasicInfo,
  type IFileWriteRequest,
  type IPacketCallback,
  type MatchMode,
  SerialDeviceType,
  type SlotNumber,
  USER_FLASH_USR_CODE_START,
  USER_PROG_CHUNK_SIZE,
  type SelectDashScreen,
} from "./Vex";
import { VexEventTarget } from "./VexEvent";
import { type ProgramIniConfig } from "./VexIniConfig";
import {
  MatchStatusReplyD2HPacket,
  DeviceBoundPacket,
  GetMatchStatusH2DPacket,
  UpdateMatchModeH2DPacket,
  MatchModeReplyD2HPacket,
  GetSystemStatusReplyD2HPacket,
  GetSystemStatusH2DPacket,
  type HostBoundPacket,
  InitFileTransferH2DPacket,
  InitFileTransferReplyD2HPacket,
  LinkFileH2DPacket,
  ExitFileTransferH2DPacket,
  ExitFileTransferReplyD2HPacket,
  WriteFileReplyD2HPacket,
  WriteFileH2DPacket,
  LinkFileReplyD2HPacket,
  ReadFileH2DPacket,
  ReadFileReplyD2HPacket,
  PacketEncoder,
  SystemVersionH2DPacket,
  SystemVersionReplyD2HPacket,
  Query1H2DPacket,
  Query1ReplyD2HPacket,
  LoadFileActionH2DPacket,
  LoadFileActionReplyD2HPacket,
  GetSystemFlagsH2DPacket,
  GetSystemFlagsReplyD2HPacket,
  GetRadioStatusH2DPacket,
  GetRadioStatusReplyD2HPacket,
  GetDeviceStatusH2DPacket,
  GetDeviceStatusReplyD2HPacket,
  SendDashTouchH2DPacket,
  SendDashTouchReplyD2HPacket,
  SelectDashH2DPacket,
  type SelectDashReplyD2HPacket,
} from "./VexPacket";
import { type VexFirmwareVersion } from "./VexFirmwareVersion";

const thePacketEncoder = PacketEncoder.getInstance();

/**
 * A connection to a V5 device.
 * Emit events: connected, disconnected
 */
export class VexSerialConnection extends VexEventTarget {
  filters: SerialPortFilter[] = [{ usbVendorId: 10376 }];

  writer: WritableStreamDefaultWriter<unknown> | undefined;
  reader: ReadableStreamDefaultReader<unknown> | undefined;
  port: SerialPort | undefined;
  serial: Serial;

  callbacksQueue: IPacketCallback[] = [];

  get isConnected(): boolean {
    return (
      this.port !== undefined &&
      this.reader !== undefined &&
      this.writer !== undefined
    );
  }

  constructor(serial: Serial) {
    super();
    this.serial = serial;
  }

  async close(): Promise<void> {
    if (!this.isConnected) return;

    try {
      await this.writer?.close();
      this.writer = undefined;
    } catch (e) {}

    try {
      await this.reader?.cancel();
      try {
        while (this.reader != null) {
          const { done } = await this.reader.read();
          if (done) break;
        }
      } catch (e) {}
      this.reader = undefined;
    } catch (e) {}

    try {
      await new Promise((resolve) => setTimeout(resolve, 1)); // HACK: wait for the lock to be released
      await this.port?.close();
      this.port = undefined;
    } catch (e) {
      console.warn("Close port error.", e);
    } finally {
      this.emit("disconnected", undefined);
    }
  }

  async open(
    use: number | undefined = 0,
    askUser: boolean = true,
  ): Promise<boolean | undefined> {
    if (this.port !== undefined) throw new Error("Already connected.");

    let port: SerialPort | undefined;

    if (use !== undefined) {
      const ports = (await this.serial.getPorts())
        .filter((p) => {
          const info = p.getInfo();
          return this.filters.find(
            (f) =>
              (f.usbVendorId === undefined ||
                f.usbVendorId === info.usbVendorId) &&
              (f.usbProductId === undefined ||
                f.usbProductId === info.usbProductId),
          );
        })
        .filter((e) => e.readable !== null);

      port = ports[use];
    }

    if (port == null && askUser) {
      try {
        port = await this.serial.requestPort({ filters: this.filters });
      } catch (e) {
        console.warn("No valid port selected.");
      }
    }

    if (port == null) return undefined;

    if (port.readable != null) return false;

    try {
      await port.open({ baudRate: 115200 });

      this.port = port;

      this.port.addEventListener("disconnect", () => {
        void this.close();
      });

      this.emit("connected", undefined);

      this.writer = this.port.writable.getWriter();
      this.reader = this.port.readable.getReader();
      void this.startReader();

      return true;
    } catch (e) {
      return false;
    }
  }

  writeData(
    rawData: DeviceBoundPacket | Uint8Array,
    resolve: (data: HostBoundPacket | ArrayBuffer | AckType) => void,
    timeout: number = 1000,
  ): void {
    void this.writeDataAsync(rawData, timeout).then(resolve);
  }

  async writeDataAsync(
    rawData: DeviceBoundPacket | Uint8Array,
    timeout: number = 1000,
  ): Promise<HostBoundPacket | ArrayBuffer | AckType> {
    return await new Promise<HostBoundPacket | ArrayBuffer | AckType>(
      (resolve) => {
        if (this.writer === undefined) {
          resolve(AckType.CDC2_NACK);
          return;
        }

        const data: Uint8Array =
          rawData instanceof DeviceBoundPacket ? rawData.data : rawData;
        const cb = {
          callback: resolve,
          timeout: setTimeout(() => {
            this.callbacksQueue.shift()?.callback(AckType.TIMEOUT);
          }, timeout),
          wantedCommandId:
            rawData instanceof DeviceBoundPacket
              ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (rawData.constructor as any).COMMAND_ID
              : undefined,
          wantedCommandExId:
            rawData instanceof DeviceBoundPacket
              ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (rawData.constructor as any).COMMAND_EXTENDED_ID
              : undefined,
        };
        this.callbacksQueue.push(cb);

        this.writer
          .write(data)
          .then(() => {
            logData(data, 100);
          })
          .catch(() => {
            this.callbacksQueue.splice(this.callbacksQueue.indexOf(cb), 1);
            resolve(AckType.WRITE_ERROR);
          });
      },
    );
  }

  protected async readData(
    cache: Uint8Array,
    expectedSize: number,
  ): Promise<Uint8Array> {
    if (this.reader == null) throw new Error("No reader");

    while (cache.byteLength < expectedSize) {
      const { value: readData, done: isDone } = await this.reader.read();

      if (isDone) throw new Error("No data");

      cache = binaryArrayJoin(cache, readData as Uint8Array);
    }

    return cache;
  }

  protected async startReader(): Promise<void> {
    let cache = new Uint8Array([]);
    let sliceIdx = 0;
    for (;;)
      try {
        cache = await this.readData(cache, 5);
        sliceIdx = 0;

        if (!thePacketEncoder.validateHeader(cache))
          throw new Error("Invalid header");

        const payloadExpectedSize = thePacketEncoder.getPayloadSize(cache);
        const n = payloadExpectedSize > 128 ? 5 : 4;
        const totalSize = n + payloadExpectedSize;

        cache = await this.readData(cache, totalSize);
        sliceIdx = totalSize + 1;

        const cmdId = cache[2];
        const hasExtId = cmdId === 88 || cmdId === 86;
        const cmdExId = hasExtId ? cache[n] : undefined;

        const ack = cache[n + 1];

        if (hasExtId) {
          if (!thePacketEncoder.validateMessageCdc(cache))
            throw new Error("Invalid message CDC");
        }

        let callbackInfo: IPacketCallback | undefined;
        let wantedCmdId: number | undefined;
        let wantedCmdExId: number | undefined;
        let tryIdx = 0;
        while ((callbackInfo = this.callbacksQueue[tryIdx++]) !== null) {
          wantedCmdId = callbackInfo?.wantedCommandId;
          wantedCmdExId = callbackInfo?.wantedCommandExId;

          if (
            (wantedCmdId !== undefined && wantedCmdId !== cmdId) ||
            (wantedCmdExId !== undefined && wantedCmdExId !== cmdExId)
          ) {
            continue;
          }
          break;
        }

        if (callbackInfo === undefined) {
          console.warn("Unexpected command", cmdId, cmdExId, ack);
          // TODO: trigger event
          continue;
        }

        const data = cache.slice(0, sliceIdx);
        const PackageType =
          thePacketEncoder.allPacketsTable[wantedCmdId + " " + wantedCmdExId];
        if (
          (wantedCmdId === undefined && wantedCmdExId === undefined) ||
          PackageType === undefined
        ) {
          callbackInfo.callback(data);
        } else {
          if (!hasExtId || PackageType.isValidPacket(data, n)) {
            callbackInfo.callback(new PackageType(data));
          } else {
            console.warn("ack", ack);

            callbackInfo.callback(ack);
          }
        }

        clearTimeout(callbackInfo.timeout);

        this.callbacksQueue.splice(tryIdx - 1, 1);
      } catch (e) {
        console.warn("Read error.", e, cache);

        await this.close();
        break;
      } finally {
        cache = cache.slice(sliceIdx);
      }
  }

  async query1(): Promise<Query1ReplyD2HPacket | null> {
    const result = await this.writeDataAsync(new Query1H2DPacket(), 100);
    return result instanceof Query1ReplyD2HPacket ? result : null;
  }

  async getSystemVersion(): Promise<VexFirmwareVersion | null> {
    const result = await this.writeDataAsync(new SystemVersionH2DPacket());
    return result instanceof SystemVersionReplyD2HPacket
      ? result.version
      : null;
  }
}

export class V5SerialConnection extends VexSerialConnection {
  filters: SerialPortFilter[] = [
    { usbVendorId: 10376, usbProductId: SerialDeviceType.V5_BRAIN },
    { usbVendorId: 10376, usbProductId: SerialDeviceType.V5_BRAIN_DFU },
    { usbVendorId: 10376, usbProductId: SerialDeviceType.V5_CONTROLLER },
  ];

  async getDeviceStatus(): Promise<GetDeviceStatusReplyD2HPacket | null> {
    const result = await this.writeDataAsync(new GetDeviceStatusH2DPacket());
    return result instanceof GetDeviceStatusReplyD2HPacket ? result : null;
  }

  async getRadioStatus(): Promise<GetRadioStatusReplyD2HPacket | null> {
    const result = await this.writeDataAsync(new GetRadioStatusH2DPacket());
    return result instanceof GetRadioStatusReplyD2HPacket ? result : null;
  }

  async getSystemFlags(): Promise<GetSystemFlagsReplyD2HPacket | null> {
    const result = await this.writeDataAsync(new GetSystemFlagsH2DPacket());
    return result instanceof GetSystemFlagsReplyD2HPacket ? result : null;
  }

  async getSystemStatus(
    timeout = 1000,
  ): Promise<GetSystemStatusReplyD2HPacket | null> {
    const result = await this.writeDataAsync(
      new GetSystemStatusH2DPacket(),
      timeout,
    );
    return result instanceof GetSystemStatusReplyD2HPacket ? result : null;
  }

  async getMatchStatus(): Promise<MatchStatusReplyD2HPacket | null> {
    const result = await this.writeDataAsync(new GetMatchStatusH2DPacket());
    return result instanceof MatchStatusReplyD2HPacket ? result : null;
  }

  async uploadProgramToDevice(
    iniConfig: ProgramIniConfig,
    binFileBuf: Uint8Array,
    coldFileBuf: Uint8Array | undefined,
    progressCallback: (state: string, current: number, total: number) => void,
  ): Promise<boolean | undefined> {
    const iniFileBuffer = new TextEncoder().encode(iniConfig.createIni());

    const basename = iniConfig.baseName;

    const iniRequest = {
      filename: basename + ".ini",
      buf: iniFileBuffer,
      downloadTarget: FileDownloadTarget.FILE_TARGET_QSPI,
      vid: FileVendor.USER,
      autoRun: false,
    };
    const r1 = await this.uploadFileToDevice(iniRequest, (current, total) => {
      progressCallback("INI", current, total);
    });
    if (!r1) return false;

    // let prjRequest = { filename: basename + '.prj', buf: prjfile, vid: FileVendor.USER, loadAddr: undefined, exttype: 0, linkedFile: undefined };
    // await this.uploadFileToDeviceAsync(prjRequest, onProgress);

    const coldRequest =
      coldFileBuf !== undefined
        ? {
            filename: basename + "_lib.bin",
            buf: coldFileBuf,
            downloadTarget: FileDownloadTarget.FILE_TARGET_QSPI,
            vid: 24, // PROS vendor id
            autoRun: false,
          }
        : undefined;
    if (coldRequest != null) {
      const r2 = await this.uploadFileToDevice(
        coldRequest,
        (current, total) => {
          progressCallback("COLD", current, total);
        },
      );
      if (!r2) return;
    }

    const binRequest = {
      filename: basename + ".bin",
      buf: binFileBuf,
      downloadTarget: FileDownloadTarget.FILE_TARGET_QSPI,
      vid: FileVendor.USER,
      loadAddress: coldFileBuf != null ? 0x07800000 : undefined,
      autoRun: iniConfig.autorun,
      linkedFile: coldRequest,
    };
    const r3 = await this.uploadFileToDevice(binRequest, (current, total) => {
      progressCallback("BIN", current, total);
    });

    return r3;
  }

  async downloadFileToHost(
    request: IFileBasicInfo,
    downloadTarget = FileDownloadTarget.FILE_TARGET_QSPI,
    progressCallback?: (current: number, total: number) => void,
  ): Promise<Uint8Array> {
    // TODO assert that the device is connected

    const { filename, vendor, loadAddress, size } = request;

    let nextAddress = loadAddress ?? USER_FLASH_USR_CODE_START;

    const p1 = await this.writeDataAsync(
      new InitFileTransferH2DPacket(
        FileInitAction.READ,
        downloadTarget,
        vendor,
        FileInitOption.NONE,
        new Uint8Array(),
        nextAddress,
        filename,
        "",
      ),
    );

    if (!(p1 instanceof InitFileTransferReplyD2HPacket))
      throw new Error("InitFileTransferH2DPacket failed");

    const fileSize = size ?? p1.fileSize;

    // console.log("size:", fileSize);

    const bufferChunkSize =
      p1.windowSize > 0 && p1.windowSize <= USER_PROG_CHUNK_SIZE
        ? p1.windowSize
        : USER_PROG_CHUNK_SIZE;
    let bufferOffset = 0;
    let fileBuf = new Uint8Array(fileSize + bufferChunkSize);

    let lastBlock = false;

    while (!lastBlock) {
      if (fileSize <= bufferOffset + bufferChunkSize) {
        lastBlock = true;
      }

      const p2 = await this.writeDataAsync(
        new ReadFileH2DPacket(nextAddress, bufferChunkSize),
        3000,
      );

      if (!(p2 instanceof ReadFileReplyD2HPacket))
        throw new Error("ReadFileReplyD2HPacket failed");

      fileBuf.set(new Uint8Array(p2.buf), bufferOffset);

      if (progressCallback != null) progressCallback(bufferOffset, fileSize);

      // next chunk
      bufferOffset += bufferChunkSize;
      nextAddress += bufferChunkSize;
    }

    await this.writeDataAsync(
      new ExitFileTransferH2DPacket(FileExitAction.EXIT_HALT),
      30000,
    );
    // console.log(p3);

    fileBuf = fileBuf.slice(0, fileSize);

    return fileBuf;
  }

  async uploadFileToDevice(
    request: IFileWriteRequest,
    progressCallback?: (current: number, total: number) => void,
  ): Promise<boolean> {
    let {
      filename,
      buf,
      downloadTarget,
      vendor,
      loadAddress,
      exttype,
      autoRun,
      linkedFile,
    } = request;

    if (buf === undefined) {
      // TODO: check connection status
      return false;
    }

    // no download to special capture or vision buffers

    // if (this.downloadTarget === VexDeviceWebSerial.FILE_TARGET_CBUF || this.downloadTarget === VexDeviceWebSerial.FILE_TARGET_VBUF) {
    //     // error !
    //     if (doneCallback != undefined) {
    //         doneCallback(false);
    //     }
    //     return;
    // }

    downloadTarget = downloadTarget ?? FileDownloadTarget.FILE_TARGET_QSPI;
    vendor = vendor ?? FileVendor.USER;

    let nextAddress = loadAddress ?? USER_FLASH_USR_CODE_START;

    // TODO if downloadTarget is FILE_TARGET_A1, FactoryEnable

    // TODO if buf.length > USER_FLASH_MAX_FILE_SIZE and downloadTarget is FILE_TARGET_QSPI, change to FILE_TARGET_DDR

    console.log("init file transfer", filename);

    const p1 = await this.writeDataAsync(
      new InitFileTransferH2DPacket(
        FileInitAction.WRITE,
        downloadTarget,
        vendor,
        FileInitOption.OVERWRITE,
        buf,
        nextAddress,
        filename,
        exttype,
      ),
    );

    if (!(p1 instanceof InitFileTransferReplyD2HPacket))
      throw new Error("InitFileTransferH2DPacket failed");
    console.log(p1);

    if (linkedFile !== undefined) {
      const p3 = await this.writeDataAsync(
        new LinkFileH2DPacket(
          linkedFile.vendor ?? FileVendor.USER,
          linkedFile.filename,
          0,
        ),
        10000,
      );

      if (!(p3 instanceof LinkFileReplyD2HPacket))
        throw new Error("LinkFileH2DPacket failed");
    }

    const bufferChunkSize =
      p1.windowSize > 0 && p1.windowSize <= USER_PROG_CHUNK_SIZE
        ? p1.windowSize
        : USER_PROG_CHUNK_SIZE;
    let bufferOffset = 0;

    let lastBlock = false;

    while (!lastBlock) {
      let tmpbuf;
      if (buf.byteLength - bufferOffset > bufferChunkSize) {
        tmpbuf = buf.subarray(bufferOffset, bufferOffset + bufferChunkSize);
      } else {
        // last chunk
        // word align length
        const length = ((buf.byteLength - bufferOffset + 3) / 4) >>> 0;
        tmpbuf = new Uint8Array(length * 4);
        tmpbuf.set(buf.subarray(bufferOffset, buf.byteLength));
        lastBlock = true;
      }

      const p2 = await this.writeDataAsync(
        new WriteFileH2DPacket(nextAddress, tmpbuf),
        3000,
      );

      if (!(p2 instanceof WriteFileReplyD2HPacket))
        throw new Error("WriteFileReplyD2HPacket failed");

      if (progressCallback != null)
        progressCallback(bufferOffset, buf.byteLength);

      // next chunk
      bufferOffset += bufferChunkSize;
      nextAddress += bufferChunkSize;
    }

    const p4 = await this.writeDataAsync(
      new ExitFileTransferH2DPacket(
        autoRun ? FileExitAction.EXIT_RUN : FileExitAction.EXIT_HALT,
      ),
      30000,
    );

    return p4 instanceof ExitFileTransferReplyD2HPacket;
  }

  async setMatchMode(mode: MatchMode): Promise<MatchModeReplyD2HPacket | null> {
    const result = await this.writeDataAsync(
      new UpdateMatchModeH2DPacket(mode, 0),
    );
    return result instanceof MatchModeReplyD2HPacket ? result : null;
  }

  async loadProgram(
    value: SlotNumber | string,
  ): Promise<LoadFileActionReplyD2HPacket | null> {
    const result = await this.writeDataAsync(
      new LoadFileActionH2DPacket(FileVendor.USER, FileLoadAction.RUN, value),
    );
    return result instanceof LoadFileActionReplyD2HPacket ? result : null;
  }

  async stopProgram(): Promise<LoadFileActionReplyD2HPacket | null> {
    const result = await this.writeDataAsync(
      new LoadFileActionH2DPacket(FileVendor.USER, FileLoadAction.STOP, ""),
    );
    return result instanceof LoadFileActionReplyD2HPacket ? result : null;
  }

  async mockTouch(
    x: number,
    y: number,
    press: boolean,
  ): Promise<SendDashTouchReplyD2HPacket | null> {
    const result = await this.writeDataAsync(
      new SendDashTouchH2DPacket(x, y, press),
    );
    return result instanceof SendDashTouchReplyD2HPacket ? result : null;
  }

  /** @param port untested */
  async openScreen(
    screen: number | SelectDashScreen,
    port: number,
  ): Promise<SelectDashReplyD2HPacket | null> {
    const result = await this.writeDataAsync(
      new SelectDashH2DPacket(screen, port),
    );
    return result instanceof SendDashTouchReplyD2HPacket ? result : null;
  }
}

function logData(data: Uint8Array, limitedSize: number): void {
  if (data === undefined) return;

  limitedSize ||= data.length;
  let a = "";
  for (let n = 0; n < data.length && n < limitedSize; n++)
    a += ("00" + data[n].toString(16)).substr(-2, 2) + " ";
  limitedSize < data.length && (a += " ... ");

  // console.log(a);

  // XXX: NOT USED?
}

function binaryArrayJoin(
  left: Uint8Array | ArrayBuffer | null,
  right: Uint8Array | ArrayBuffer | null,
): Uint8Array {
  const leftSize = left != null ? left.byteLength : 0;
  const rightSize = right != null ? right.byteLength : 0;
  const all = new Uint8Array(leftSize + rightSize);
  return all.length === 0
    ? new Uint8Array()
    : (left != null && all.set(new Uint8Array(left), 0),
      right != null && all.set(new Uint8Array(right), leftSize),
      all);
}
