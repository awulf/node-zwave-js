import {
	CommandClasses,
	Maybe,
	parseBitMask,
	validatePayload,
	ValueID,
	ValueMetadata,
	ZWaveError,
	ZWaveErrorCodes,
} from "@zwave-js/core";
import { getEnumMemberName, pick } from "@zwave-js/shared";
import type { Driver } from "../driver/Driver";
import log from "../log";
import { CCAPI } from "./API";
import {
	API,
	CCCommand,
	CCCommandOptions,
	CCResponsePredicate,
	ccValue,
	CommandClass,
	commandClass,
	CommandClassDeserializationOptions,
	expectedCCResponse,
	gotDeserializationOptions,
	implementedVersion,
} from "./CommandClass";

// All the supported commands
export enum AlarmSensorCommand {
	Get = 0x01,
	Report = 0x02,
	SupportedGet = 0x03,
	SupportedReport = 0x04,
}

// @publicAPI
export enum AlarmSensorType {
	"General Purpose" = 0x00,
	Smoke,
	CO,
	CO2,
	Heat,
	"Water Leak",
	Any = 0xff,
}

export function getAlarmSensorStateValueId(
	endpointIndex: number | undefined,
	sensorType: AlarmSensorType,
): ValueID {
	return {
		commandClass: CommandClasses["Alarm Sensor"],
		endpoint: endpointIndex,
		property: "state",
		propertyKey: sensorType,
	};
}

export function getAlarmSensorSeverityValueId(
	endpointIndex: number | undefined,
	sensorType: AlarmSensorType,
): ValueID {
	return {
		commandClass: CommandClasses["Alarm Sensor"],
		endpoint: endpointIndex,
		property: "severity",
		propertyKey: sensorType,
	};
}

export function getAlarmSensorDurationValueId(
	endpointIndex: number | undefined,
	sensorType: AlarmSensorType,
): ValueID {
	return {
		commandClass: CommandClasses["Alarm Sensor"],
		endpoint: endpointIndex,
		property: "duration",
		propertyKey: sensorType,
	};
}

export function getSupportedSensorTypesValueId(endpointIndex: number): ValueID {
	return {
		commandClass: CommandClasses["Alarm Sensor"],
		endpoint: endpointIndex,
		property: "supportedSensorTypes",
	};
}

// @noSetValueAPI This CC is read-only

@API(CommandClasses["Alarm Sensor"])
export class AlarmSensorCCAPI extends CCAPI {
	public supportsCommand(cmd: AlarmSensorCommand): Maybe<boolean> {
		switch (cmd) {
			case AlarmSensorCommand.Get:
			case AlarmSensorCommand.SupportedGet:
				return true; // This is mandatory
		}
		return super.supportsCommand(cmd);
	}

	/**
	 * Retrieves the current value from this sensor
	 * @param sensorType The (optional) sensor type to retrieve the value for
	 */
	public async get(sensorType?: AlarmSensorType) {
		this.assertSupportsCommand(AlarmSensorCommand, AlarmSensorCommand.Get);

		const cc = new AlarmSensorCCGet(this.driver, {
			nodeId: this.endpoint.nodeId,
			endpoint: this.endpoint.index,
			sensorType,
		});
		const response = (await this.driver.sendCommand<AlarmSensorCCReport>(
			cc,
		))!;
		return pick(response, ["state", "severity", "duration"]);
	}

	// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
	public async getSupportedSensorTypes() {
		this.assertSupportsCommand(
			AlarmSensorCommand,
			AlarmSensorCommand.SupportedGet,
		);

		const cc = new AlarmSensorCCSupportedGet(this.driver, {
			nodeId: this.endpoint.nodeId,
			endpoint: this.endpoint.index,
		});
		const response = (await this.driver.sendCommand<
			AlarmSensorCCSupportedReport
		>(cc))!;
		return response.supportedSensorTypes;
	}
}

@commandClass(CommandClasses["Alarm Sensor"])
@implementedVersion(1)
export class AlarmSensorCC extends CommandClass {
	declare ccCommand: AlarmSensorCommand;

	public async interview(complete: boolean = true): Promise<void> {
		const node = this.getNode()!;
		const endpoint = this.getEndpoint()!;

		// Skip the interview in favor of Notification CC if possible
		if (endpoint.commandClasses.Notification.isSupported()) {
			log.controller.logNode(node.id, {
				endpoint: this.endpointIndex,
				message: `${this.constructor.name}: skipping interview because Notification CC is supported...`,
				direction: "none",
			});
			this.interviewComplete = true;
			return;
		}

		const api = endpoint.commandClasses["Alarm Sensor"];

		log.controller.logNode(node.id, {
			endpoint: this.endpointIndex,
			message: `${this.constructor.name}: doing a ${
				complete ? "complete" : "partial"
			} interview...`,
			direction: "none",
		});

		// Find out which sensor types this sensor supports
		let supportedSensorTypes: readonly AlarmSensorType[];
		if (complete) {
			log.controller.logNode(node.id, {
				endpoint: this.endpointIndex,
				message: "querying supported sensor types...",
				direction: "outbound",
			});
			supportedSensorTypes = await api.getSupportedSensorTypes();
			const logMessage = `received supported sensor types: ${supportedSensorTypes
				.map((type) => getEnumMemberName(AlarmSensorType, type))
				.map((name) => `\n· ${name}`)
				.join("")}`;
			log.controller.logNode(node.id, {
				endpoint: this.endpointIndex,
				message: logMessage,
				direction: "inbound",
			});
		} else {
			supportedSensorTypes =
				this.getValueDB().getValue(
					getSupportedSensorTypesValueId(this.endpointIndex),
				) ?? [];
		}

		// Always query (all of) the sensor's current value(s)
		for (const type of supportedSensorTypes) {
			const sensorName = getEnumMemberName(AlarmSensorType, type);

			log.controller.logNode(node.id, {
				endpoint: this.endpointIndex,
				message: `querying current value for ${sensorName}...`,
				direction: "outbound",
			});
			const currentValue = await api.get(type);
			log.controller.logNode(node.id, {
				endpoint: this.endpointIndex,
				message: `received current value for ${sensorName}: ${currentValue}`,
				direction: "inbound",
			});
		}

		// Remember that the interview is complete
		this.interviewComplete = true;
	}
}

@CCCommand(AlarmSensorCommand.Report)
export class AlarmSensorCCReport extends AlarmSensorCC {
	public constructor(
		driver: Driver,
		options: CommandClassDeserializationOptions,
	) {
		super(driver, options);
		validatePayload(this.payload.length >= 5, this.payload[1] !== 0xff);
		this.nodeId = this.payload[0];
		this.sensorType = this.payload[1];
		// Any positive value gets interpreted as alarm
		this.state = this.payload[2] > 0;
		// Severity only ranges from 1 to 100
		if (this.payload[2] > 0 && this.payload[2] <= 0x64) {
			this.severity = this.payload[2];
		}
		// ignore zero durations
		this.duration = this.payload.readUInt16BE(3) || undefined;

		this.persistValues();
	}

	public readonly sensorType: AlarmSensorType;
	public readonly state: boolean;
	public readonly severity: number | undefined;
	public readonly duration: number | undefined;

	public persistValues(): boolean {
		const stateValueId = getAlarmSensorStateValueId(
			this.endpointIndex,
			this.sensorType,
		);
		const severityValueId = getAlarmSensorSeverityValueId(
			this.endpointIndex,
			this.sensorType,
		);
		const durationValueId = getAlarmSensorDurationValueId(
			this.endpointIndex,
			this.sensorType,
		);
		const valueDB = this.getValueDB();
		const alarmName = getEnumMemberName(AlarmSensorType, this.sensorType);

		// Always create metadata if it does not exist
		if (!valueDB.hasMetadata(stateValueId)) {
			valueDB.setMetadata(stateValueId, {
				...ValueMetadata.ReadOnlyBoolean,
				label: `${alarmName} state`,
				description: "Whether the alarm is active",
			});
		}
		if (!valueDB.hasMetadata(severityValueId)) {
			valueDB.setMetadata(severityValueId, {
				...ValueMetadata.ReadOnlyNumber,
				min: 1,
				max: 100,
				unit: "%",
				label: `${alarmName} severity`,
			});
		}
		if (!valueDB.hasMetadata(durationValueId)) {
			valueDB.setMetadata(durationValueId, {
				...ValueMetadata.ReadOnlyNumber,
				unit: "s",
				label: `${alarmName} duration`,
				description: "For how long the alarm should be active",
			});
		}

		valueDB.setValue(stateValueId, this.state);
		valueDB.setValue(severityValueId, this.severity);
		valueDB.setValue(durationValueId, this.duration);

		return true;
	}
}

const testResponseForAlarmSensorGet: CCResponsePredicate = (
	sent: AlarmSensorCCGet,
	received,
	isPositiveTransmitReport,
) => {
	// We expect a Alarm Sensor Report that matches the requested sensor type (if a type was requested)
	return received instanceof AlarmSensorCCReport &&
		(sent.sensorType === AlarmSensorType.Any ||
			received.sensorType === sent.sensorType)
		? "final"
		: isPositiveTransmitReport
		? "confirmation"
		: "unexpected";
};

interface AlarmSensorCCGetOptions extends CCCommandOptions {
	sensorType?: AlarmSensorType;
}

@CCCommand(AlarmSensorCommand.Get)
@expectedCCResponse(testResponseForAlarmSensorGet)
export class AlarmSensorCCGet extends AlarmSensorCC {
	public constructor(
		driver: Driver,
		options: CommandClassDeserializationOptions | AlarmSensorCCGetOptions,
	) {
		super(driver, options);
		if (gotDeserializationOptions(options)) {
			// TODO: Deserialize payload
			throw new ZWaveError(
				`${this.constructor.name}: deserialization not implemented`,
				ZWaveErrorCodes.Deserialization_NotImplemented,
			);
		} else {
			this.sensorType = options.sensorType ?? AlarmSensorType.Any;
		}
	}

	public sensorType: AlarmSensorType;

	public serialize(): Buffer {
		this.payload = Buffer.from([this.sensorType]);
		return super.serialize();
	}
}

@CCCommand(AlarmSensorCommand.SupportedReport)
export class AlarmSensorCCSupportedReport extends AlarmSensorCC {
	public constructor(
		driver: Driver,
		options: CommandClassDeserializationOptions,
	) {
		super(driver, options);
		validatePayload(this.payload.length >= 1);
		const bitMaskLength = this.payload[0];
		validatePayload(this.payload.length >= 1 + bitMaskLength);
		this._supportedSensorTypes = parseBitMask(
			this.payload.slice(1, 1 + bitMaskLength),
			AlarmSensorType["General Purpose"],
		);

		this.persistValues();
	}

	private _supportedSensorTypes: AlarmSensorType[];
	@ccValue({ internal: true })
	public get supportedSensorTypes(): readonly AlarmSensorType[] {
		return this._supportedSensorTypes;
	}
}

@CCCommand(AlarmSensorCommand.SupportedGet)
@expectedCCResponse(AlarmSensorCCSupportedReport)
export class AlarmSensorCCSupportedGet extends AlarmSensorCC {}