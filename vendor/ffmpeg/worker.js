/// <reference no-default-lib="true" />
/// <reference lib="esnext" />
/// <reference lib="webworker" />
import { CORE_URL, FFMessageType } from "./const.js";
import { ERROR_UNKNOWN_MESSAGE_TYPE, ERROR_NOT_LOADED, ERROR_IMPORT_FAILURE, } from "./errors.js";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readlinkSync, readSync, renameSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
let ffmpeg;
const installBunFS = (core) => {
    if (core.FS.filesystems.BUNFS)
        return;
    const FS = core.FS;
    const isDirMode = (mode) => (mode & 61440) === 16384;
    const BUNFS = {
        DIR_MODE: 16895,
        FILE_MODE: 33279,
        mount(mount) {
            const root = BUNFS.createNode(null, "/", BUNFS.DIR_MODE, 0);
            root.hostPath = mount.opts.rootPath;
            root.write = !!mount.opts.write;
            if (root.hostPath)
                mkdirSync(root.hostPath, { recursive: true });
            const createdParents = {};
            const ensureParent = (path) => {
                const parts = path.split("/").filter(Boolean);
                let parent = root;
                for (let i = 0; i < parts.length - 1; i++) {
                    const curr = parts.slice(0, i + 1).join("/");
                    if (!createdParents[curr]) {
                        createdParents[curr] = BUNFS.createNode(parent, parts[i], BUNFS.DIR_MODE, 0, {
                            path: parent.hostPath ? join(parent.hostPath, parts[i]) : undefined,
                            write: root.write,
                        });
                    }
                    parent = createdParents[curr];
                }
                return parent;
            };
            const base = (path) => path.split("/").filter(Boolean).pop() || path;
            for (const file of mount.opts.files || []) {
                const stat = statSync(file.path);
                BUNFS.createNode(ensureParent(file.name), base(file.name), BUNFS.FILE_MODE, 0, {
                    path: file.path,
                    size: file.size ?? stat.size,
                    mtimeMs: file.lastModified ?? stat.mtimeMs,
                    write: false,
                });
            }
            return root;
        },
        createNode(parent, name, mode, dev, contents) {
            const node = FS.createNode(parent, name, mode, dev);
            node.mode = mode;
            node.node_ops = BUNFS.node_ops;
            node.stream_ops = BUNFS.stream_ops;
            node.timestamp = contents?.mtimeMs || Date.now();
            if (mode === BUNFS.FILE_MODE) {
                node.size = contents.size || 0;
                node.contents = contents;
            }
            else {
                node.size = 4096;
                node.contents = {};
            }
            node.hostPath = contents?.path || (parent?.hostPath ? join(parent.hostPath, name) : undefined);
            node.write = !!(contents?.write || parent?.write);
            if (parent)
                parent.contents[name] = node;
            return node;
        },
        node_ops: {
            getattr(node) {
                return {
                    dev: 1,
                    ino: node.id,
                    mode: node.mode,
                    nlink: 1,
                    uid: 0,
                    gid: 0,
                    rdev: undefined,
                    size: node.size,
                    atime: new Date(node.timestamp),
                    mtime: new Date(node.timestamp),
                    ctime: new Date(node.timestamp),
                    blksize: 4096,
                    blocks: Math.ceil(node.size / 4096),
                };
            },
            setattr(node, attr) {
                if (attr.mode !== undefined)
                    node.mode = attr.mode;
                if (attr.timestamp !== undefined)
                    node.timestamp = attr.timestamp;
            },
            lookup(parent, name) {
                if (!parent.hostPath)
                    throw new FS.ErrnoError(44);
                const path = join(parent.hostPath, name);
                if (!existsSync(path))
                    throw new FS.ErrnoError(44);
                const stat = statSync(path);
                return BUNFS.createNode(parent, name, stat.isDirectory() ? BUNFS.DIR_MODE : BUNFS.FILE_MODE, 0, {
                    path,
                    size: stat.isDirectory() ? 4096 : stat.size,
                    mtimeMs: stat.mtimeMs,
                    write: parent.write,
                });
            },
            mknod(parent, name, mode, dev) {
                if (!parent.write || !parent.hostPath)
                    throw new FS.ErrnoError(63);
                const path = join(parent.hostPath, name);
                mkdirSync(dirname(path), { recursive: true });
                if (isDirMode(mode))
                    mkdirSync(path, { recursive: true });
                return BUNFS.createNode(parent, name, mode, dev, {
                    path,
                    size: 0,
                    write: true,
                });
            },
            rename(oldNode, newDir, newName) {
                if (!oldNode.write || !newDir.write || !oldNode.hostPath || !newDir.hostPath)
                    throw new FS.ErrnoError(63);
                const newPath = join(newDir.hostPath, newName);
                mkdirSync(dirname(newPath), { recursive: true });
                renameSync(oldNode.hostPath, newPath);
                if (oldNode.parent?.contents)
                    delete oldNode.parent.contents[oldNode.name];
                oldNode.name = newName;
                oldNode.parent = newDir;
                oldNode.hostPath = newPath;
                newDir.contents[newName] = oldNode;
            },
            unlink(parent, name) {
                if (!parent.write || !parent.hostPath)
                    throw new FS.ErrnoError(63);
                const node = parent.contents[name];
                const path = node?.hostPath || join(parent.hostPath, name);
                if (existsSync(path))
                    unlinkSync(path);
                delete parent.contents[name];
            },
            rmdir(parent, name) {
                if (!parent.write || !parent.hostPath)
                    throw new FS.ErrnoError(63);
                const node = parent.contents[name];
                const path = node?.hostPath || join(parent.hostPath, name);
                if (existsSync(path))
                    rmdirSync(path);
                delete parent.contents[name];
            },
            readdir(node) {
                const names = new Set(Object.keys(node.contents));
                if (node.hostPath && existsSync(node.hostPath)) {
                    for (const name of readdirSync(node.hostPath))
                        names.add(name);
                }
                return [".", "..", ...names];
            },
            symlink(parent, newName, oldPath) {
                if (!parent.write || !parent.hostPath)
                    throw new FS.ErrnoError(63);
                const path = join(parent.hostPath, newName);
                mkdirSync(dirname(path), { recursive: true });
                symlinkSync(oldPath, path);
                return BUNFS.createNode(parent, newName, BUNFS.FILE_MODE, 0, {
                    path,
                    size: 0,
                    write: parent.write,
                });
            },
            readlink(node) {
                if (!node.hostPath)
                    throw new FS.ErrnoError(44);
                return readlinkSync(node.hostPath);
            },
        },
        stream_ops: {
            open(stream) {
                if (stream.node.write) {
                    mkdirSync(dirname(stream.node.hostPath), { recursive: true });
                    stream.bunfd = openSync(stream.node.hostPath, "w+");
                }
                else {
                    stream.bunfd = openSync(stream.node.contents.path, "r");
                }
            },
            close(stream) {
                if (stream.bunfd !== undefined) {
                    closeSync(stream.bunfd);
                    stream.bunfd = undefined;
                }
            },
            read(stream, buffer, offset, length, position) {
                if (position >= stream.node.size)
                    return 0;
                if (stream.bunfd === undefined)
                    stream.bunfd = openSync(stream.node.contents.path, "r");
                const bytesToRead = Math.min(length, stream.node.size - position);
                const target = new Uint8Array(buffer.buffer, buffer.byteOffset + offset, bytesToRead);
                return readSync(stream.bunfd, target, 0, bytesToRead, position);
            },
            write(stream, buffer, offset, length, position) {
                if (!stream.node.write)
                    throw new FS.ErrnoError(29);
                if (stream.bunfd === undefined) {
                    mkdirSync(dirname(stream.node.hostPath), { recursive: true });
                    stream.bunfd = openSync(stream.node.hostPath, "w+");
                }
                const source = new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length);
                const written = writeSync(stream.bunfd, source, 0, length, position);
                stream.node.size = Math.max(stream.node.size, position + written);
                return written;
            },
            llseek(stream, offset, whence) {
                let position = offset;
                if (whence === 1)
                    position += stream.position;
                else if (whence === 2)
                    position += stream.node.size;
                if (position < 0)
                    throw new FS.ErrnoError(28);
                return position;
            },
        },
    };
    core.FS.filesystems.BUNFS = BUNFS;
};
const load = async ({ coreURL: _coreURL, wasmURL: _wasmURL, workerURL: _workerURL, }) => {
    const first = !ffmpeg;
    try {
        if (!_coreURL)
            _coreURL = CORE_URL;
        // when web worker type is `classic`.
        importScripts(_coreURL);
    }
    catch {
        if (!_coreURL)
            _coreURL = CORE_URL.replace('/umd/', '/esm/');
        // when web worker type is `module`.
        self.createFFmpegCore = (await import(
        /* webpackIgnore: true */ /* @vite-ignore */ _coreURL)).default;
        if (!self.createFFmpegCore) {
            throw ERROR_IMPORT_FAILURE;
        }
    }
    const coreURL = _coreURL;
    const wasmURL = _wasmURL ? _wasmURL : _coreURL.replace(/.js$/g, ".wasm");
    const workerURL = _workerURL
        ? _workerURL
        : _coreURL.replace(/.js$/g, ".worker.js");
    ffmpeg = await self.createFFmpegCore({
        // Fix `Overload resolution failed.` when using multi-threaded ffmpeg-core.
        // Encoded wasmURL and workerURL in the URL as a hack to fix locateFile issue.
        mainScriptUrlOrBlob: `${coreURL}#${btoa(JSON.stringify({ wasmURL, workerURL }))}`,
    });
    installBunFS(ffmpeg);
    ffmpeg.setLogger((data) => self.postMessage({ type: FFMessageType.LOG, data }));
    ffmpeg.setProgress((data) => self.postMessage({
        type: FFMessageType.PROGRESS,
        data,
    }));
    return first;
};
const exec = ({ args, timeout = -1 }) => {
    ffmpeg.setTimeout(timeout);
    ffmpeg.exec(...args);
    const ret = ffmpeg.ret;
    ffmpeg.reset();
    return ret;
};
const writeFile = ({ path, data }) => {
    ffmpeg.FS.writeFile(path, data);
    return true;
};
const readFile = ({ path, encoding }) => ffmpeg.FS.readFile(path, { encoding });
// TODO: check if deletion works.
const deleteFile = ({ path }) => {
    ffmpeg.FS.unlink(path);
    return true;
};
const rename = ({ oldPath, newPath }) => {
    ffmpeg.FS.rename(oldPath, newPath);
    return true;
};
// TODO: check if creation works.
const createDir = ({ path }) => {
    ffmpeg.FS.mkdir(path);
    return true;
};
const listDir = ({ path }) => {
    const names = ffmpeg.FS.readdir(path);
    const nodes = [];
    for (const name of names) {
        const stat = ffmpeg.FS.stat(`${path}/${name}`);
        const isDir = ffmpeg.FS.isDir(stat.mode);
        nodes.push({ name, isDir });
    }
    return nodes;
};
// TODO: check if deletion works.
const deleteDir = ({ path }) => {
    ffmpeg.FS.rmdir(path);
    return true;
};
const mount = ({ fsType, options, mountPoint }) => {
    const str = fsType;
    const fs = ffmpeg.FS.filesystems[str];
    if (!fs)
        return false;
    ffmpeg.FS.mount(fs, options, mountPoint);
    return true;
};
const unmount = ({ mountPoint }) => {
    ffmpeg.FS.unmount(mountPoint);
    return true;
};
self.onmessage = async ({ data: { id, type, data: _data }, }) => {
    const trans = [];
    let data;
    try {
        if (type !== FFMessageType.LOAD && !ffmpeg)
            throw ERROR_NOT_LOADED; // eslint-disable-line
        switch (type) {
            case FFMessageType.LOAD:
                data = await load(_data);
                break;
            case FFMessageType.EXEC:
                data = exec(_data);
                break;
            case FFMessageType.WRITE_FILE:
                data = writeFile(_data);
                break;
            case FFMessageType.READ_FILE:
                data = readFile(_data);
                break;
            case FFMessageType.DELETE_FILE:
                data = deleteFile(_data);
                break;
            case FFMessageType.RENAME:
                data = rename(_data);
                break;
            case FFMessageType.CREATE_DIR:
                data = createDir(_data);
                break;
            case FFMessageType.LIST_DIR:
                data = listDir(_data);
                break;
            case FFMessageType.DELETE_DIR:
                data = deleteDir(_data);
                break;
            case FFMessageType.MOUNT:
                data = mount(_data);
                break;
            case FFMessageType.UNMOUNT:
                data = unmount(_data);
                break;
            default:
                throw ERROR_UNKNOWN_MESSAGE_TYPE;
        }
    }
    catch (e) {
        self.postMessage({
            id,
            type: FFMessageType.ERROR,
            data: e.toString(),
        });
        return;
    }
    if (data instanceof Uint8Array) {
        trans.push(data.buffer);
    }
    self.postMessage({ id, type, data }, trans);
};
