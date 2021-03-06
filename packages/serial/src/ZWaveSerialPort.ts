import type SerialPort from "serialport";
import { ZWaveSerialPortBase } from "./ZWaveSerialPortBase";

/** The default version of the Z-Wave serial binding that works using node-serialport */
export class ZWaveSerialPort extends ZWaveSerialPortBase {
	constructor(port: string);
	/** @internal */ constructor(port: string, Binding: typeof SerialPort);
	constructor(
		port: string,
		Binding: typeof SerialPort = require("serialport"),
	) {
		super({
			create: () =>
				new Binding(port, {
					autoOpen: false,
					baudRate: 115200,
					dataBits: 8,
					stopBits: 1,
					parity: "none",
				}),
			open: (serial: SerialPort) =>
				new Promise((resolve) => {
					serial.once("open", resolve).open();
				}),
			close: (serial: SerialPort) =>
				new Promise((resolve) => {
					serial.once("close", resolve).close();
				}),
		});
	}

	public get isOpen(): boolean {
		return (this.serial as SerialPort).isOpen;
	}
}
