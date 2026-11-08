interface Box { type: string; data: number; end: number }

function readBoxes(bytes: Buffer, start: number, end: number): Box[] {
  const boxes: Box[] = [];
  while (start < end) {
    if (end - start < 8 || boxes.length >= 2048) throw new Error('Invalid MP4 box table.');
    const size = bytes.readUInt32BE(start);
    const type = bytes.toString('latin1', start + 4, start + 8);
    const header = size === 1 ? 16 : 8;
    if (end - start < header) throw new Error('Truncated MP4 box.');
    const length = size === 1 ? Number(bytes.readBigUInt64BE(start + 8)) : size || end - start;
    if (!Number.isSafeInteger(length) || length < header || length > end - start) throw new Error('Invalid MP4 box length.');
    boxes.push({ type, data: start + header, end: start + length });
    start += length;
  }
  return boxes;
}

/** Check the container and the declared video codec without decoding user media. */
export function isH264Mp4(bytes: Buffer) {
  try {
    const top = readBoxes(bytes, 0, bytes.length);
    if (top[0]?.type !== 'ftyp' || top[0].end - top[0].data < 8
      || !top.some(box => box.type === 'mdat' && box.end > box.data)) return false;
    const children = (box: Box) => readBoxes(bytes, box.data, box.end);
    const find = (box: Box, type: string) => children(box).find(child => child.type === type);
    const movie = top.find(box => box.type === 'moov');
    if (!movie) return false;
    const tracks = children(movie).filter(box => box.type === 'trak');
    for (const track of tracks) {
      const media = find(track, 'mdia');
      if (!media) continue;
      const handler = find(media, 'hdlr');
      if (!handler || handler.end - handler.data < 12 || bytes.toString('latin1', handler.data + 8, handler.data + 12) !== 'vide') continue;
      const info = find(media, 'minf'), table = info && find(info, 'stbl'), descriptors = table && find(table, 'stsd');
      if (!descriptors || descriptors.end - descriptors.data < 8) return false;
      const samples = readBoxes(bytes, descriptors.data + 8, descriptors.end);
      return bytes.readUInt32BE(descriptors.data + 4) === samples.length
        && samples.length > 0 && samples.every(sample => {
          if (sample.type !== 'avc1' && sample.type !== 'avc3') return false;
          // VisualSampleEntry has a 78-byte header before its codec configuration boxes.
          const configurationStart = sample.data + 78;
          if (configurationStart > sample.end) return false;
          return readBoxes(bytes, configurationStart, sample.end).some(box =>
            box.type === 'avcC' && box.end - box.data >= 7 && bytes[box.data] === 1);
        });
    }
    return false;
  } catch {
    return false;
  }
}
