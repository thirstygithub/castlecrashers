(() => {
  const KEEP = 40 << 20, SMALL = 256 << 10;
  const BASE = self.CC_BASE || '';
  const urlOf = path => BASE + path.slice(1).split('/').map(encodeURIComponent).join('/');
  const fetchSync = url => {
    for (let tries = 0; ; tries++) {
      try {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', tries ? url + (url.includes('?') ? '&' : '?') + 'r=' + tries : url, false);
        xhr.overrideMimeType('text/plain; charset=x-user-defined');
        xhr.send(null);
        if (xhr.status !== 200) throw new Error(url + ': ' + xhr.status);
        const text = xhr.responseText, bytes = new Uint8Array(text.length);
        for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
        return bytes;
      } catch (e) {
        if (tries >= 5) throw e;
        const until = performance.now() + 400;
        while (performance.now() < until) {}
      }
    }
  };
  const makeDirs = (FS, dir) => {
    let at = '';
    for (const part of dir.split('/').filter(Boolean)) {
      at += '/' + part;
      try { FS.mkdir(at); } catch {}
    }
  };
  self.fetchSmallPack = async (list, onProgress) => {
    let total = 0;
    for (const [offset, size] of Object.values(list.pack)) total = Math.max(total, offset + size);
    const manifest = await (await fetch(BASE + 'small.pack.parts.json')).json();
    const pack = new Uint8Array(total);
    let got = 0;
    await Promise.all(manifest.parts.map(async part => {
      const response = await fetch(BASE + part.name);
      if (!response.ok) throw new Error(part.name + ': ' + response.status);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length !== part.size) throw new Error(part.name + ': truncated');
      pack.set(bytes, part.offset);
      got += bytes.length;
      onProgress(got, total);
    }));
    if (got !== total) throw new Error('small.pack: truncated');
    return pack;
  };
  self.mountLazyFiles = (Module, list, pack) => {
    const FS = Module.FS, MEMFS = FS.filesystems.MEMFS, closed = new Map();
    let closedBytes = 0;
    const stats = Module.peLazyStats = { loads: 0, bytes: 0 };
    const load = node => {
      if (node.contents) return;
      let bytes;
      try { bytes = fetchSync(node.lazyUrl); } catch { throw new FS.ErrnoError(29); }
      node.contents = bytes;
      node.usedBytes = bytes.length;
      stats.loads++;
      stats.bytes += bytes.length;
    };
    const nodeOps = {
      getattr(node) {
        const attr = MEMFS.node_ops.getattr(node);
        if (!node.contents && !node.dirty) attr.size = node.lazySize;
        return attr;
      },
      setattr(node, attr) {
        if (attr.size !== undefined) load(node), node.dirty = true;
        return MEMFS.node_ops.setattr(node, attr);
      },
    };
    const streamOps = {
      open({ node }) {
        if (closed.has(node)) closedBytes -= node.usedBytes, closed.delete(node);
        load(node);
        node.opens = (node.opens || 0) + 1;
      },
      close({ node }) {
        if (--node.opens || node.dirty || node.usedBytes <= SMALL) return;
        closed.set(node, true);
        closedBytes += node.usedBytes;
        for (const [old] of closed) {
          if (closedBytes <= KEEP) break;
          closed.delete(old);
          closedBytes -= old.usedBytes;
          old.contents = null;
          old.usedBytes = 0;
        }
      },
      llseek: MEMFS.stream_ops.llseek,
      read: MEMFS.stream_ops.read,
      write(stream, ...rest) { stream.node.dirty = true; return MEMFS.stream_ops.write(stream, ...rest); },
      mmap: MEMFS.stream_ops.mmap,
      msync: MEMFS.stream_ops.msync,
    };
    for (const [path, [offset, size]] of Object.entries(list.pack)) {
      const cut = path.lastIndexOf('/');
      makeDirs(FS, path.slice(0, cut));
      FS.createDataFile(path.slice(0, cut), path.slice(cut + 1), pack.subarray(offset, offset + size), true, true, true);
    }
    for (const [path, size] of Object.entries(list.lazy)) {
      const cut = path.lastIndexOf('/');
      makeDirs(FS, path.slice(0, cut));
      const node = FS.createFile(path.slice(0, cut), path.slice(cut + 1), {}, true, true);
      node.lazyUrl = urlOf(path);
      node.lazySize = size;
      node.node_ops = nodeOps;
      node.stream_ops = streamOps;
    }
  };
  self.prefetchLazyFiles = async list => {
    const rank = p => /\/game\//.test(p) ? 0 : /\/(levels|bsps)\//.test(p) ? 1 : 2;
    const names = Object.keys(list.lazy).sort((a, b) => rank(a) - rank(b) || list.lazy[a] - list.lazy[b]);
    for (const path of names) {
      for (let tries = 0; tries < 4; tries++) {
        try {
          const url = urlOf(path) + (tries ? '?r=' + tries : '');
          await (await fetch(url, { priority: 'low' })).body.pipeTo(new WritableStream());
          break;
        } catch {
          await new Promise(done => setTimeout(done, 500 * (tries + 1)));
        }
      }
    }
  };
})();
