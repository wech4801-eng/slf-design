'use strict';
/**
 * Écriture d'une archive ZIP en flux (sans dépendance), pour la sauvegarde
 * complète téléchargeable depuis l'administration. Les photos sont stockées
 * telles quelles (déjà compressées), les fichiers texte sont compressés.
 * Limite : 4 Go par fichier et pour l'archive (largement suffisant ici).
 */
const zlib = require('zlib');

function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

function write(stream, buf) {
  return new Promise((resolve, reject) => {
    if (stream.destroyed) return reject(new Error('flux fermé'));
    if (stream.write(buf)) return resolve();
    const onDrain = () => { stream.off('close', onClose); resolve(); };
    const onClose = () => { stream.off('drain', onDrain); reject(new Error('flux fermé')); };
    stream.once('drain', onDrain);
    stream.once('close', onClose);
  });
}

class ZipWriter {
  constructor(stream) {
    this.stream = stream;
    this.offset = 0;
    this.entries = [];
  }

  async add(name, data, mtime = new Date()) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(data);
    const compress = /\.(json|txt|csv|html|md)$/i.test(name);
    const body = compress ? zlib.deflateRawSync(data, { level: 6 }) : data;
    const method = compress ? 8 : 0;
    const { time, date } = dosDateTime(mtime);

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6); // noms en UTF-8
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);

    this.entries.push({ nameBuf, crc, method, time, date, csize: body.length, size: data.length, offset: this.offset });
    await write(this.stream, Buffer.concat([header, nameBuf]));
    await write(this.stream, body);
    this.offset += header.length + nameBuf.length + body.length;
  }

  async finish() {
    const start = this.offset;
    const parts = [];
    for (const e of this.entries) {
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE(20, 4);
      h.writeUInt16LE(20, 6);
      h.writeUInt16LE(0x0800, 8);
      h.writeUInt16LE(e.method, 10);
      h.writeUInt16LE(e.time, 12);
      h.writeUInt16LE(e.date, 14);
      h.writeUInt32LE(e.crc, 16);
      h.writeUInt32LE(e.csize, 20);
      h.writeUInt32LE(e.size, 24);
      h.writeUInt16LE(e.nameBuf.length, 28);
      h.writeUInt32LE(e.offset, 42);
      parts.push(h, e.nameBuf);
    }
    const central = Buffer.concat(parts);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(central.length, 12);
    end.writeUInt32LE(start, 16);
    await write(this.stream, Buffer.concat([central, end]));
    this.stream.end();
  }
}

module.exports = { ZipWriter };
