import { type ZerobaseSlotNumber } from "./Vex";

export class ProgramIniConfig {
  baseName = "slot_1";
  autorun = false;
  project = { version: "1", ide: "Unknown", file: "none" };
  program = {
    version: "1",
    name: "program",
    slot: 0 as ZerobaseSlotNumber,
    icon: "default.bmp",
    iconalt: "",
    description: "",
    date: "",
    timezone: "0",
  };

  config: Record<number, string> = {}; // { port_22: "..." }
  controller1: Record<string, string> = {};
  controller2: Record<string, string> = {};
  // private options: { [key: string]: string } = {};

  constructor() {
    this.config = {
      22: "adi",
    };
  }

  setProgramDate(date: Date) {
    const d = date;
    this.program.date = d.toISOString();
    const tzo = Math.abs(d.getTimezoneOffset());
    const tzh = (tzo / 60) >>> 0;
    const tzm = tzo - tzh * 60;
    this.program.timezone =
      (d.getTimezoneOffset() > 0 ? "-" : "+") +
      this.dec2(tzh) +
      ":" +
      this.dec2(tzm);
  }

  createIni() {
    const str = [];
    if (!this.program.date) {
      this.setProgramDate(new Date());
    }
    str.push(";" + "\n");
    str.push("; VEX program ini file" + "\n");
    str.push("; Generated by Vex V5 Serial Protocol Library" + "\n");
    str.push(";" + "\n");
    str.push("[project]" + "\n");
    let projectProperty;
    for (projectProperty in this.project) {
      if (this.project.hasOwnProperty(projectProperty)) {
        const s = (projectProperty + "                ").substr(0, 12);
        let t = (this.project as any)[projectProperty];
        if (s.match("ide")) {
          t = t.substr(0, 16);
        }
        str.push(s + ' = "' + t + '"\n');
      }
    }
    str.push(";" + "\n");
    str.push("[program]" + "\n");
    let programProperty;
    for (programProperty in this.program) {
      if (this.program.hasOwnProperty(programProperty)) {
        const s = (programProperty + "                ").substr(0, 12);
        let t = (this.program as any)[programProperty];
        // skip new alternate icon if it is not set
        if (s.match("name")) {
          t = t.substr(0, 32);
        } else if (s.match("description")) {
          t = t.substr(0, 256);
        } else if (s.match("icon")) {
          t = t.substr(0, 16);
        } else if (s.match("iconalt")) {
          if (t == "") continue;
          t = t.substr(0, 16);
        }
        str.push(s + ' = "' + t + '"\n');
      }
    }
    str.push(";" + "\n");
    str.push("[config]" + "\n");
    let configProperty;
    for (configProperty in this.config) {
      if (this.config.hasOwnProperty(configProperty)) {
        const s = (
          "port_" +
          this.dec2(parseInt(configProperty)) +
          "                "
        ).substr(0, 12);
        const t = this.config[configProperty];
        str.push(s + ' = "' + t + '"\n');
      }
    }
    if (Object.keys(this.controller1).length > 0) {
      str.push(";" + "\n");
      str.push("[controller_1]" + "\n");
      for (const property in this.controller1) {
        if (this.controller1.hasOwnProperty(property)) {
          const s = (property + "                ").substr(0, 12);
          const t = this.controller1[property];
          str.push(s + ' = "' + t + '"\n');
        }
      }
    }
    if (Object.keys(this.controller2).length > 0) {
      str.push(";" + "\n");
      str.push("[controller_2]" + "\n");
      for (const property in this.controller2) {
        if (this.controller2.hasOwnProperty(property)) {
          const s = (property + "                ").substr(0, 12);
          const t = this.controller2[property];
          str.push(s + ' = "' + t + '"\n');
        }
      }
    }
    const s = str.join("");
    console.log(s);
    return s;
  }

  dec2(value: number) {
    const str = ("00" + value.toString(10)).substr(-2, 2);
    return str.toUpperCase();
  }
}
