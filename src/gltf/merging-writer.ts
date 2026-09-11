/**
 * MergingGLTFWriter - Writes IMF.IScene to GLB with mesh merging by material.
 *
 * Instead of one mesh per fragment (potentially hundreds of thousands of meshes),
 * this writer:
 * 1. Bakes each fragment's transform into its geometry vertices
 * 2. Groups fragments by material
 * 3. Merges all geometries in the same material group into one mesh
 * 4. Outputs a single GLB file
 *
 * This drastically reduces draw calls (from N fragments to ~N materials)
 * and JSON size, making the model web-friendly.
 */

import * as path from 'path';
import * as fse from 'fs-extra';
import * as IMF from '../common/intermediate-format';

// ---------------------------------------------------------------------------
// Matrix math helpers
// ---------------------------------------------------------------------------

function getTransformMatrix(transform: IMF.Transform | undefined): number[] {
    if (!transform) return [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
    if (transform.kind === IMF.TransformKind.Matrix) return transform.elements;
    const { translation: t, rotation: q, scale: s } = transform as IMF.IDecomposedTransform;
    const m = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
    if (s) { m[0]=s.x; m[5]=s.y; m[10]=s.z; }
    if (q) {
        const { x, y, z, w } = q;
        const xx=x*x, yy=y*y, zz=z*z, xy=x*y, xz=x*z, yz=y*z, wx=w*x, wy=w*y, wz=w*z;
        const sx=m[0], sy=m[5], sz=m[10];
        m[0]=(1-2*(yy+zz))*sx; m[1]=(2*(xy+wz))*sx;   m[2]=(2*(xz-wy))*sx;
        m[4]=(2*(xy-wz))*sy;   m[5]=(1-2*(xx+zz))*sy;  m[6]=(2*(yz+wx))*sy;
        m[8]=(2*(xz+wy))*sz;   m[9]=(2*(yz-wx))*sz;    m[10]=(1-2*(xx+yy))*sz;
    }
    if (t) { m[12]=t.x; m[13]=t.y; m[14]=t.z; }
    return m;
}

function transformPoint(m: number[], x: number, y: number, z: number): [number, number, number] {
    return [
        m[0]*x + m[4]*y + m[8]*z  + m[12],
        m[1]*x + m[5]*y + m[9]*z  + m[13],
        m[2]*x + m[6]*y + m[10]*z + m[14],
    ];
}

function getNormalMatrix(m: number[]): number[] {
    const a00=m[0], a01=m[4], a02=m[8], a10=m[1], a11=m[5], a12=m[9], a20=m[2], a21=m[6], a22=m[10];
    return [
        a11*a22 - a12*a21,   -(a01*a22 - a02*a21),   a01*a12 - a02*a11,
       -(a10*a22 - a12*a20),  a00*a22 - a02*a20,    -(a00*a12 - a02*a10),
        a10*a21 - a11*a20,   -(a00*a21 - a01*a20),   a00*a11 - a01*a10,
    ];
}

function transformNormal(nm: number[], nx: number, ny: number, nz: number): [number, number, number] {
    let rx = nm[0]*nx + nm[3]*ny + nm[6]*nz;
    let ry = nm[1]*nx + nm[4]*ny + nm[7]*nz;
    let rz = nm[2]*nx + nm[5]*ny + nm[8]*nz;
    const len = Math.sqrt(rx*rx + ry*ry + rz*rz) || 1;
    return [rx/len, ry/len, rz/len];
}

function multiplyMatrices(a: number[], b: number[]): number[] {
    const r = new Array(16);
    for (let col = 0; col < 4; col++)
        for (let row = 0; row < 4; row++)
            r[col*4+row] = a[row]*b[col*4] + a[4+row]*b[col*4+1] + a[8+row]*b[col*4+2] + a[12+row]*b[col*4+3];
    return r;
}

function pad4(n: number): number { return (n + 3) & ~3; }

// ---------------------------------------------------------------------------
// MergeGroup - accumulates geometry for one material using temp files
// ---------------------------------------------------------------------------

class MergeGroup {
    materialID: number;
    id: string;
    vertexOffset = 0;
    totalVertices = 0;
    totalIndices = 0;
    hasNormals = false;

    posPath: string;
    nrmPath: string;
    idxPath: string;
    posFd: number;
    nrmFd: number;
    idxFd: number;

    constructor(materialID: number, tempDir: string, id: string) {
        this.materialID = materialID;
        this.id = id;
        const prefix = path.join(tempDir, `g${id}`);
        this.posPath = prefix + '_pos.bin';
        this.nrmPath = prefix + '_nrm.bin';
        this.idxPath = prefix + '_idx.bin';
        this.posFd = fse.openSync(this.posPath, 'w');
        this.nrmFd = fse.openSync(this.nrmPath, 'w');
        this.idxFd = fse.openSync(this.idxPath, 'w');
    }

    appendMesh(verts: Float32Array, norms: Float32Array | undefined, indices: Uint16Array, matrix: number[]): void {
        const tVerts = new Float32Array(verts.length);
        for (let i = 0; i < verts.length; i += 3) {
            const [x, y, z] = transformPoint(matrix, verts[i], verts[i+1], verts[i+2]);
            tVerts[i] = x; tVerts[i+1] = y; tVerts[i+2] = z;
        }
        fse.writeSync(this.posFd, Buffer.from(tVerts.buffer));

        if (norms) {
            const nm = getNormalMatrix(matrix);
            const tNorms = new Float32Array(norms.length);
            for (let i = 0; i < norms.length; i += 3) {
                const [nx, ny, nz] = transformNormal(nm, norms[i], norms[i+1], norms[i+2]);
                tNorms[i] = nx; tNorms[i+1] = ny; tNorms[i+2] = nz;
            }
            fse.writeSync(this.nrmFd, Buffer.from(tNorms.buffer));
            this.hasNormals = true;
        }

        const offsetIndices = new Uint32Array(indices.length);
        for (let i = 0; i < indices.length; i++) offsetIndices[i] = indices[i] + this.vertexOffset;
        fse.writeSync(this.idxFd, Buffer.from(offsetIndices.buffer));

        this.vertexOffset += verts.length / 3;
        this.totalVertices += verts.length / 3;
        this.totalIndices += indices.length;
    }

    appendLines(verts: Float32Array, indices: Uint16Array, matrix: number[]): void {
        const tVerts = new Float32Array(verts.length);
        for (let i = 0; i < verts.length; i += 3) {
            const [x, y, z] = transformPoint(matrix, verts[i], verts[i+1], verts[i+2]);
            tVerts[i] = x; tVerts[i+1] = y; tVerts[i+2] = z;
        }
        fse.writeSync(this.posFd, Buffer.from(tVerts.buffer));

        const offsetIndices = new Uint32Array(indices.length);
        for (let i = 0; i < indices.length; i++) offsetIndices[i] = indices[i] + this.vertexOffset;
        fse.writeSync(this.idxFd, Buffer.from(offsetIndices.buffer));

        this.vertexOffset += verts.length / 3;
        this.totalVertices += verts.length / 3;
        this.totalIndices += indices.length;
    }

    close(): void {
        fse.closeSync(this.posFd);
        fse.closeSync(this.nrmFd);
        fse.closeSync(this.idxFd);
    }
}

// ---------------------------------------------------------------------------
// MergingGLTFWriter
// ---------------------------------------------------------------------------

export interface IMergingWriterOptions {
    center?: boolean; /** Move the model to origin. */
    log?: (msg: string) => void; /** Optional logging function. */
}

interface IGroupMeta {
    matID: number;
    group: MergeGroup;
    isLine: boolean;
    posBvOffset: number;
    posBvSize: number;
    nrmBvOffset: number;
    nrmBvSize: number;
    idxBvOffset: number;
    idxBvSize: number;
}

/**
 * Utility class for serializing parsed 3D content to a single GLB file,
 * merging all meshes that share the same material into a single draw call.
 */
export class MergingWriter {
    protected options: { center: boolean; log: (msg: string) => void };

    constructor(options: IMergingWriterOptions = {}) {
        this.options = {
            center: options.center ?? true,
            log: options.log || (() => {}),
        };
    }

    /**
     * Outputs scene into a single GLB file with merged meshes.
     * @async
     * @param {IMF.IScene} imf Complete scene in intermediate, in-memory format.
     * @param {string} outputGlbPath Path to output GLB file.
     */
    async write(imf: IMF.IScene, outputGlbPath: string): Promise<void> {
        const tempDir = outputGlbPath + '.tmp';
        fse.ensureDirSync(tempDir);

        try {
            const { meshGroups, lineGroups } = await this._collectGeometry(imf, tempDir);

            // Close all file descriptors
            const allGroups = [...meshGroups.values(), ...lineGroups.values()];
            allGroups.forEach(g => g.close());

            this.options.log(`Merged into ${meshGroups.size} mesh groups + ${lineGroups.size} line groups`);

            // Build and write GLB in a single pass
            await this._buildAndWriteGLB(imf, meshGroups, lineGroups, outputGlbPath);

        } finally {
            fse.removeSync(tempDir);
        }
    }

    protected async _collectGeometry(imf: IMF.IScene, tempDir: string): Promise<{
        meshGroups: Map<number, MergeGroup>;
        lineGroups: Map<number, MergeGroup>;
    }> {
        const meshGroups = new Map<number, MergeGroup>();
        const lineGroups = new Map<number, MergeGroup>();
        let meshGid = 0, lineGid = 0;
        const nodeCount = imf.getNodeCount();
        const globalMatrix = this._computeGlobalTransform(imf.getMetadata());

        for (let i = 0; i < nodeCount; i++) {
            const node = imf.getNode(i);
            if (node.kind !== IMF.NodeKind.Object) continue;

            const fragment = node as IMF.IObjectNode;
            const geometry = imf.getGeometry(fragment.geometry);
            if (geometry.kind === IMF.GeometryKind.Empty) continue;

            const nodeMatrix = getTransformMatrix(fragment.transform);
            const matrix = multiplyMatrices(globalMatrix, nodeMatrix);
            const matID = fragment.material;

            if (geometry.kind === IMF.GeometryKind.Mesh) {
                let group = meshGroups.get(matID);
                if (!group) { group = new MergeGroup(matID, tempDir, `mesh_${meshGid++}`); meshGroups.set(matID, group); }
                group.appendMesh(geometry.getVertices(), geometry.getNormals(), geometry.getIndices(), matrix);
            } else if (geometry.kind === IMF.GeometryKind.Lines) {
                let group = lineGroups.get(matID);
                if (!group) { group = new MergeGroup(matID, tempDir, `line_${lineGid++}`); lineGroups.set(matID, group); }
                group.appendLines(geometry.getVertices(), geometry.getIndices(), matrix);
            }

            if (i % 50000 === 0 || i === nodeCount - 1) {
                this.options.log(`Processing nodes: ${i + 1}/${nodeCount}`);
            }
        }

        return { meshGroups, lineGroups };
    }

    protected _computeGlobalTransform(metadata: IMF.IMetadata): number[] {
        let m = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
        if (!metadata) return m;
        const up = metadata['world up vector']?.XYZ;
        const front = metadata['world front vector']?.XYZ;
        const distanceUnit = metadata['distance unit']?.value;
        if (!up || !front) return m;
        const left = [up[1]*front[2]-up[2]*front[1], up[2]*front[0]-up[0]*front[2], up[0]*front[1]-up[1]*front[0]];
        if (left[0]*left[0]+left[1]*left[1]+left[2]*left[2] === 0) return m;
        let scale = 1.0;
        switch (distanceUnit) {
            case 'centimeter': case 'cm': scale = 0.01; break;
            case 'millimeter': case 'mm': scale = 0.001; break;
            case 'foot': case 'ft': scale = 0.3048; break;
            case 'inch': case 'in': scale = 0.0254; break;
        }
        m[0]=left[0]*scale; m[4]=up[0]*scale; m[8]=front[0]*scale; m[12]=0;
        m[1]=left[1]*scale; m[5]=up[1]*scale; m[9]=front[1]*scale; m[13]=0;
        m[2]=left[2]*scale; m[6]=up[2]*scale; m[10]=front[2]*scale; m[14]=0;
        m[3]=0; m[7]=0; m[11]=0; m[15]=1;
        return m;
    }

    protected async _buildAndWriteGLB(
        imf: IMF.IScene,
        meshGroups: Map<number, MergeGroup>,
        lineGroups: Map<number, MergeGroup>,
        outputGlbPath: string
    ): Promise<void> {
        // Sort groups deterministically
        const sortedMesh = [...meshGroups.entries()].sort((a, b) => a[0] - b[0]);
        const sortedLine = [...lineGroups.entries()].sort((a, b) => a[0] - b[0]);
        const allEntries = [...sortedMesh, ...sortedLine];

        // --- First pass: compute bounds and byte offsets ---
        let binOffset = 0;
        const groupMeta: IGroupMeta[] = [];

        for (const [matID, group] of allEntries) {
            if (group.totalVertices === 0 || group.totalIndices === 0) continue;
            const isLine = group.id.startsWith('line_');

            const posSize = fse.statSync(group.posPath).size;
            const nrmSize = (group.hasNormals && !isLine) ? fse.statSync(group.nrmPath).size : 0;
            const idxSize = fse.statSync(group.idxPath).size;

            groupMeta.push({
                matID, group, isLine,
                posBvOffset: binOffset, posBvSize: posSize,
                nrmBvOffset: binOffset + pad4(posSize), nrmBvSize: nrmSize,
                idxBvOffset: binOffset + pad4(posSize) + pad4(nrmSize), idxBvSize: idxSize,
            });

            binOffset += pad4(posSize) + pad4(nrmSize) + pad4(idxSize);
        }

        // --- Compute bounds for centering (read position data once) ---
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (const gm of groupMeta) {
            const data = fse.readFileSync(gm.group.posPath);
            const floats = new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4);
            for (let i = 0; i < floats.length; i += 3) {
                if (floats[i] < minX) minX = floats[i]; if (floats[i] > maxX) maxX = floats[i];
                if (floats[i+1] < minY) minY = floats[i+1]; if (floats[i+1] > maxY) maxY = floats[i+1];
                if (floats[i+2] < minZ) minZ = floats[i+2]; if (floats[i+2] > maxZ) maxZ = floats[i+2];
            }
        }

        // Center offset via root node transform (avoids modifying binary data)
        const cx = this.options.center ? -0.5 * (minX + maxX) : 0;
        const cy = this.options.center ? -0.5 * (minY + maxY) : 0;
        const cz = this.options.center ? -0.5 * (minZ + maxZ) : 0;

        // --- Build glTF JSON ---
        interface GlTf {
            asset: { version: string; generator: string };
            buffers: { byteLength: number }[];
            bufferViews: { buffer: number; byteOffset: number; byteLength: number; target?: number }[];
            accessors: { bufferView: number; componentType: number; count: number; type: string; min?: number[]; max?: number[] }[];
            meshes: { primitives: { mode?: number; attributes: Record<string, number>; indices: number; material?: number }[] }[];
            materials: Record<string, any>[];
            nodes: Record<string, any>[];
            scenes: { nodes: number[] }[];
            scene: number;
        }

        const gltf: GlTf = {
            asset: { version: '2.0', generator: 'merging-gltf-writer' },
            buffers: [{ byteLength: binOffset }],
            bufferViews: [],
            accessors: [],
            meshes: [],
            materials: [],
            nodes: [],
            scenes: [{ nodes: [] }],
            scene: 0,
        };

        // Root node with centering transform
        const rootNodeIdx = gltf.nodes.push({
            children: [] as number[],
            matrix: [1,0,0,0, 0,1,0,0, 0,0,1,0, cx,cy,cz,1],
        }) - 1;
        gltf.scenes[0].nodes.push(rootNodeIdx);

        // Build materials (dedup by properties)
        const materialMap = new Map<string, { svfID: number; gltfIndex: number }>();
        for (let i = 0; i < imf.getMaterialCount(); i++) {
            const mat = imf.getMaterial(i);
            const hash = this._materialHash(mat);
            if (!materialMap.has(hash)) {
                materialMap.set(hash, { svfID: i, gltfIndex: gltf.materials.length });
                gltf.materials.push(this._createMaterial(mat));
            }
        }
        const svfToGltfMat = new Map<number, number>();
        for (const [, info] of materialMap) svfToGltfMat.set(info.svfID, info.gltfIndex);

        // Create bufferViews, accessors, meshes, nodes for each group
        for (const gm of groupMeta) {
            // Position accessor
            const posBvIdx = gltf.bufferViews.length;
            gltf.bufferViews.push({ buffer: 0, byteOffset: gm.posBvOffset, byteLength: gm.posBvSize, target: 34962 });
            const posAccIdx = gltf.accessors.length;
            gltf.accessors.push({
                bufferView: posBvIdx, componentType: 5126, count: gm.group.totalVertices,
                type: 'VEC3', min: [minX + cx, minY + cy, minZ + cz].map(Math.fround),
                max: [maxX + cx, maxY + cy, maxZ + cz].map(Math.fround),
            });

            // Normal accessor
            let normAccIdx: number | undefined;
            if (gm.nrmBvSize > 0) {
                const nrmBvIdx = gltf.bufferViews.length;
                gltf.bufferViews.push({ buffer: 0, byteOffset: gm.nrmBvOffset, byteLength: gm.nrmBvSize, target: 34962 });
                normAccIdx = gltf.accessors.length;
                gltf.accessors.push({ bufferView: nrmBvIdx, componentType: 5126, count: gm.group.totalVertices, type: 'VEC3' });
            }

            // Index accessor
            const idxBvIdx = gltf.bufferViews.length;
            gltf.bufferViews.push({ buffer: 0, byteOffset: gm.idxBvOffset, byteLength: gm.idxBvSize, target: 34963 });
            const idxAccIdx = gltf.accessors.length;
            gltf.accessors.push({ bufferView: idxBvIdx, componentType: 5125, count: gm.group.totalIndices, type: 'SCALAR' });

            // Mesh
            const primitive: GlTf['meshes'][0]['primitives'][0] = {
                mode: gm.isLine ? 1 : 4,
                attributes: { POSITION: posAccIdx },
                indices: idxAccIdx,
            };
            if (normAccIdx !== undefined) primitive.attributes.NORMAL = normAccIdx;
            const gltfMatIdx = svfToGltfMat.get(gm.matID);
            if (gltfMatIdx !== undefined) primitive.material = gltfMatIdx;

            const meshIdx = gltf.meshes.length;
            gltf.meshes.push({ primitives: [primitive] });

            const nodeIdx = gltf.nodes.push({ mesh: meshIdx }) - 1;
            (gltf.nodes[rootNodeIdx].children as number[]).push(nodeIdx);
        }

        // --- Write GLB ---
        const jsonStr = JSON.stringify(gltf);
        const jsonBuf = Buffer.from(jsonStr, 'utf8');
        const jsonPaddedLen = pad4(jsonBuf.length);
        const totalLength = 12 + 8 + jsonPaddedLen + (binOffset > 0 ? 8 + binOffset : 0);

        this.options.log(`GLB JSON: ${(jsonPaddedLen/1024).toFixed(0)} KB, BIN: ${(binOffset/1024/1024).toFixed(1)} MB, Total: ${(totalLength/1024/1024).toFixed(1)} MB`);

        const out = fse.createWriteStream(outputGlbPath);

        // Header
        const header = Buffer.alloc(12);
        header.writeUInt32LE(0x46546C67, 0); // glTF
        header.writeUInt32LE(2, 4);           // version
        header.writeUInt32LE(totalLength, 8);
        out.write(header);

        // JSON chunk
        const jsonHeader = Buffer.alloc(8);
        jsonHeader.writeUInt32LE(jsonPaddedLen, 0);
        jsonHeader.writeUInt32LE(0x4E4F534A, 4); // JSON
        out.write(jsonHeader);
        const jsonPadded = Buffer.alloc(jsonPaddedLen, 0x20);
        jsonBuf.copy(jsonPadded);
        out.write(jsonPadded);

        // BIN chunk
        if (binOffset > 0) {
            const binHeader = Buffer.alloc(8);
            binHeader.writeUInt32LE(binOffset, 0);
            binHeader.writeUInt32LE(0x004E4942, 4); // BIN
            out.write(binHeader);

            for (const gm of groupMeta) {
                // Positions
                const posData = fse.readFileSync(gm.group.posPath);
                out.write(posData);
                const posPad = pad4(posData.length) - posData.length;
                if (posPad > 0) out.write(Buffer.alloc(posPad, 0));

                // Normals
                if (gm.nrmBvSize > 0) {
                    const nrmData = fse.readFileSync(gm.group.nrmPath);
                    out.write(nrmData);
                    const nrmPad = pad4(nrmData.length) - nrmData.length;
                    if (nrmPad > 0) out.write(Buffer.alloc(nrmPad, 0));
                }

                // Indices
                const idxData = fse.readFileSync(gm.group.idxPath);
                out.write(idxData);
                const idxPad = pad4(idxData.length) - idxData.length;
                if (idxPad > 0) out.write(Buffer.alloc(idxPad, 0));
            }
        }

        return new Promise<void>((resolve, reject) => {
            out.on('error', reject);
            out.end(() => {
                this.options.log(`GLB written: ${outputGlbPath} (${(totalLength/1024/1024).toFixed(1)} MB)`);
                resolve();
            });
        });
    }

    protected _materialHash(mat: IMF.Material | null): string {
        if (!mat) return 'null';
        const d = mat.diffuse || {x:0,y:0,z:0};
        return `${d.x.toFixed(4)},${d.y.toFixed(4)},${d.z.toFixed(4)},${mat.metallic?.toFixed(4)},${mat.roughness?.toFixed(4)},${mat.opacity?.toFixed(4)}`;
    }

    protected _createMaterial(mat: IMF.Material | null): Record<string, any> {
        if (!mat) return { pbrMetallicRoughness: { baseColorFactor: [0.25,0.25,0.25,1], metallicFactor: 0, roughnessFactor: 0.5 } };
        const d = mat.diffuse || {x:0,y:0,z:0};
        const m: Record<string, any> = {
            pbrMetallicRoughness: {
                baseColorFactor: [d.x, d.y, d.z, 1.0],
                metallicFactor: mat.metallic ?? 0,
                roughnessFactor: Math.min(mat.roughness ?? 1, 1)
            }
        };
        if (mat.opacity !== undefined && mat.opacity < 1.0) {
            m.alphaMode = 'BLEND';
            m.pbrMetallicRoughness.baseColorFactor[3] = mat.opacity;
        }
        return m;
    }
}
