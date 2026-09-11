/*
 * APS OSS Model → SVF → GLB Conversion Script (Memory-Efficient)
 *
 * A complete pipeline script for converting models from APS OSS
 * to SVF and then to a single merged GLB file with optional Draco compression.
 *
 * Usage:
 *   node aps-to-gltf.js list                                    - List OSS buckets and objects
 *   node aps-to-gltf.js upload <bucketKey> <filePath>           - Upload file to OSS
 *   node aps-to-gltf.js translate <urn>                         - Submit/check translation to SVF
 *   node aps-to-gltf.js convert <urn> <outputDir>               - Convert SVF to merged GLB
 *   node aps-to-gltf.js auto <bucketKey> <objectKey> <output>   - Full pipeline
 *
 * Environment:
 *   APS_CLIENT_ID     - APS app client ID
 *   APS_CLIENT_SECRET - APS app client secret
 */

const path = require('path');
const fse = require('fs-extra');
const axios = require('axios');
const { SVFReader, MergingGLTFWriter, TwoLeggedAuthenticationProvider } = require('..');
const { parseMeshes } = require('../lib/svf/meshes');
const IMF = require('../lib/common/intermediate-format');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const APS_CLIENT_ID = (process.env.APS_CLIENT_ID || '').trim();
const APS_CLIENT_SECRET = (process.env.APS_CLIENT_SECRET || '').trim();

if (!APS_CLIENT_ID || !APS_CLIENT_SECRET) {
    console.error('Please set APS_CLIENT_ID and APS_CLIENT_SECRET environment variables');
    process.exit(1);
}

// ---------------------------------------------------------------------------
// APS API Helpers
// ---------------------------------------------------------------------------

async function getAccessToken(scopes = 'viewables:read data:read data:write bucket:read bucket:create') {
    const resp = await axios.post(
        'https://developer.api.autodesk.com/authentication/v2/token',
        new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: APS_CLIENT_ID,
            client_secret: APS_CLIENT_SECRET,
            scope: scopes
        }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    return resp.data.access_token;
}

async function listBuckets(token) {
    const resp = await axios.get('https://developer.api.autodesk.com/oss/v2/buckets', {
        headers: { Authorization: `Bearer ${token}` }
    });
    return resp.data.items || [];
}

async function listObjects(token, bucketKey) {
    const resp = await axios.get(
        `https://developer.api.autodesk.com/oss/v2/buckets/${bucketKey}/objects`,
        { headers: { Authorization: `Bearer ${token}` } }
    );
    return resp.data.items || [];
}

async function uploadObject(token, bucketKey, objectKey, filePath) {
    const data = fse.readFileSync(filePath);
    const resp = await axios.put(
        `https://developer.api.autodesk.com/oss/v2/buckets/${bucketKey}/objects/${objectKey}`,
        data,
        {
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/octet-stream',
                'Content-Length': data.length
            }
        }
    );
    return resp.data;
}

function objectIdToUrn(objectId) {
    return Buffer.from(objectId).toString('base64').replace(/=/g, '');
}

async function getManifest(token, urn) {
    try {
        const resp = await axios.get(
            `https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/manifest`,
            { headers: { Authorization: `Bearer ${token}` } }
        );
        return resp.data;
    } catch (err) {
        if (err.response?.status === 404) return null;
        throw err;
    }
}

async function submitTranslation(token, urn) {
    const resp = await axios.post(
        'https://developer.api.autodesk.com/modelderivative/v2/designdata/job',
        {
            input: { urn },
            output: { formats: [{ type: 'svf', views: ['3d'] }] }
        },
        {
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        }
    );
    return resp.data;
}

async function waitForTranslation(token, urn, intervalMs = 10000) {
    for (;;) {
        const manifest = await getManifest(token, urn);
        if (!manifest) throw new Error('Translation not found');
        if (manifest.status === 'success') return manifest;
        if (manifest.status === 'failed') {
            throw new Error(`Translation failed: ${JSON.stringify(manifest.messages || [])}`);
        }
        console.log(`  Progress: ${manifest.progress || 0}%  Status: ${manifest.status}`);
        await new Promise(r => setTimeout(r, intervalMs));
    }
}

function findDerivatives(manifest) {
    const results = [];
    function walk(node) {
        if (node.type === 'resource' && node.role === 'graphics') {
            if (node.mime === 'application/autodesk-svf') {
                results.push({ format: 'svf', guid: node.guid });
            }
        }
        if (node.children) node.children.forEach(walk);
    }
    (manifest.derivatives || []).forEach(d => {
        if (d.children) d.children.forEach(walk);
    });
    return results;
}

// ---------------------------------------------------------------------------
// LazySVFScene — IMF.IScene implementation with on-demand mesh pack loading
//
// Key difference from the default Scene: mesh packs are NOT all loaded into
// memory at once. Instead, raw .pf buffers are pre-downloaded to a temp
// directory (one at a time), and then loaded/parsed on demand when
// getGeometry() is called. Only one mesh pack is kept in memory at a time.
//
// Images are also pre-downloaded to disk and loaded on demand in getImage().
// ---------------------------------------------------------------------------

class LazySVFScene {
    constructor(reader, tempDir) {
        this.reader = reader;
        this.tempDir = tempDir;

        // Small data loaded upfront
        this.metadata = null;
        this.fragments = null;
        this.geometries = null;
        this.materials = null;

        // Mesh pack lazy-loading state
        this.currentPackId = -1;
        this.currentPack = null;
        this.packCount = 0;

        // Image tracking
        this.availableImages = new Set();
    }

    async init() {
        console.log('  [LazyScene] Loading metadata...');
        this.metadata = await this.reader.getMetadata();

        console.log('  [LazyScene] Loading fragments...');
        this.fragments = await this.reader.readFragments();

        console.log('  [LazyScene] Loading geometry metadata...');
        this.geometries = await this.reader.readGeometries();

        console.log('  [LazyScene] Loading materials...');
        this.materials = await this.reader.readMaterials();

        // Pre-download mesh pack buffers to temp directory (one at a time)
        this.packCount = this.reader.getMeshPackCount();
        console.log(`  [LazyScene] Pre-downloading ${this.packCount} mesh pack(s) to temp dir...`);
        const packsDir = path.join(this.tempDir, 'packs');
        fse.ensureDirSync(packsDir);
        for (let i = 0; i < this.packCount; i++) {
            console.log(`    Downloading pack ${i}/${this.packCount - 1}...`);
            const buffer = await this.reader.getAsset(`${i}.pf`);
            fse.writeFileSync(path.join(packsDir, `pack_${i}.pf`), buffer);
        }

        // Pre-download images to temp directory (one at a time)
        const imageUris = this.reader.listImages();
        console.log(`  [LazyScene] Pre-downloading ${imageUris.length} image(s) to temp dir...`);
        const imagesDir = path.join(this.tempDir, 'images');
        fse.ensureDirSync(imagesDir);
        for (const uri of imageUris) {
            try {
                const { normalizedUri, imageData } = await this.reader.loadImage(uri);
                if (imageData) {
                    const imgPath = path.join(imagesDir, normalizedUri);
                    fse.ensureDirSync(path.dirname(imgPath));
                    fse.writeFileSync(imgPath, imageData);
                    this.availableImages.add(normalizedUri);
                }
            } catch (err) {
                console.warn(`    Warning: could not download image ${uri}: ${err.message}`);
            }
        }

        console.log('  [LazyScene] Init complete. Mesh packs will be loaded on demand.');
    }

    // --- IMF.IScene interface ---

    getMetadata() {
        return this.metadata.metadata;
    }

    getNodeCount() {
        return this.fragments.length;
    }

    getNode(id) {
        const frag = this.fragments[id];
        const node = {
            kind: IMF.NodeKind.Object,
            dbid: frag.dbID,
            geometry: frag.geometryID,
            material: frag.materialID
        };
        if (frag.transform) {
            if ('matrix' in frag.transform) {
                const { matrix, t } = frag.transform;
                node.transform = {
                    kind: IMF.TransformKind.Matrix,
                    elements: [
                        matrix[0], matrix[1], matrix[2], 0,
                        matrix[3], matrix[4], matrix[5], 0,
                        matrix[6], matrix[7], matrix[8], 0,
                        t ? t.x : 0, t ? t.y : 0, t ? t.z : 0, 1
                    ]
                };
            } else {
                node.transform = { kind: IMF.TransformKind.Decomposed };
                if ('q' in frag.transform) node.transform.rotation = frag.transform.q;
                if ('s' in frag.transform) node.transform.scale = frag.transform.s;
                if ('t' in frag.transform) node.transform.translation = frag.transform.t;
            }
        }
        return node;
    }

    getGeometryCount() {
        return this.geometries.length;
    }

    getGeometry(id) {
        const meta = this.geometries[id];

        // Load the mesh pack on demand from disk (only one in memory at a time)
        if (meta.packID !== this.currentPackId) {
            const packPath = path.join(this.tempDir, 'packs', `pack_${meta.packID}.pf`);
            if (!fse.existsSync(packPath)) {
                return { kind: IMF.GeometryKind.Empty };
            }
            const buffer = fse.readFileSync(packPath);
            this.currentPack = Array.from(parseMeshes(buffer));
            this.currentPackId = meta.packID;
        }

        const mesh = this.currentPack[meta.entityID];
        if (mesh) {
            if ('isLines' in mesh) {
                return {
                    kind: IMF.GeometryKind.Lines,
                    getIndices: () => mesh.indices,
                    getVertices: () => mesh.vertices,
                    getColors: () => mesh.colors
                };
            } else if ('isPoints' in mesh) {
                return {
                    kind: IMF.GeometryKind.Points,
                    getVertices: () => mesh.vertices,
                    getColors: () => mesh.colors
                };
            } else {
                return {
                    kind: IMF.GeometryKind.Mesh,
                    getIndices: () => mesh.indices,
                    getVertices: () => mesh.vertices,
                    getNormals: () => mesh.normals,
                    getColors: () => mesh.colors,
                    getUvChannelCount: () => mesh.uvcount,
                    getUvs: (channel) => mesh.uvmaps[channel].uvs
                };
            }
        }
        return { kind: IMF.GeometryKind.Empty };
    }

    getMaterialCount() {
        return this.materials.length;
    }

    getMaterial(id) {
        const _mat = this.materials[id];
        const mat = {
            kind: IMF.MaterialKind.Physical,
            diffuse: { x: 0, y: 0, z: 0 },
            metallic: _mat?.metal ? 1.0 : 0.0,
            opacity: _mat?.opacity ?? 1.0,
            roughness: _mat?.glossiness ? (20.0 / _mat.glossiness) : 1.0,
            scale: {
                x: _mat?.maps?.diffuse?.scale?.texture_UScale ?? 1.0,
                y: _mat?.maps?.diffuse?.scale?.texture_VScale ?? 1.0
            }
        };
        if (_mat?.diffuse) {
            mat.diffuse.x = _mat.diffuse[0];
            mat.diffuse.y = _mat.diffuse[1];
            mat.diffuse.z = _mat.diffuse[2];
        }
        if (_mat?.metal && _mat.specular && _mat.glossiness) {
            mat.diffuse.x = _mat.specular[0];
            mat.diffuse.y = _mat.specular[1];
            mat.diffuse.z = _mat.specular[2];
            mat.roughness = 60 / _mat.glossiness;
        }
        if (_mat?.maps?.diffuse) {
            mat.maps = mat.maps || {};
            mat.maps.diffuse = _mat.maps.diffuse.uri;
        }
        return mat;
    }

    getImage(uri) {
        if (this.availableImages.has(uri)) {
            try {
                return fse.readFileSync(path.join(this.tempDir, 'images', uri));
            } catch { return undefined; }
        }
        return undefined;
    }

    cleanup() {
        fse.removeSync(this.tempDir);
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdList() {
    const token = await getAccessToken('bucket:read data:read');
    console.log('OSS Buckets:');
    const buckets = await listBuckets(token);
    if (buckets.length === 0) {
        console.log('  (no buckets)');
        return;
    }
    for (const bucket of buckets) {
        console.log(`\n  Bucket: ${bucket.bucketKey} (created: ${bucket.createDate})`);
        try {
            const objects = await listObjects(token, bucket.bucketKey);
            for (const obj of objects) {
                const urn = objectIdToUrn(obj.objectId);
                console.log(`    - ${obj.objectKey}  URN: ${urn}`);
            }
        } catch (err) {
            console.log(`    (could not list objects: ${err.message})`);
        }
    }
}

async function cmdUpload(bucketKey, filePath) {
    if (!fse.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
    }
    const objectKey = path.basename(filePath);
    console.log(`Uploading ${filePath} → bucket "${bucketKey}" as "${objectKey}"...`);
    const token = await getAccessToken('bucket:create data:write');
    const result = await uploadObject(token, bucketKey, objectKey, filePath);
    const urn = objectIdToUrn(result.objectId);
    console.log(`Upload complete!`);
    console.log(`  ObjectId: ${result.objectId}`);
    console.log(`  URN:      ${urn}`);
    return urn;
}

async function cmdTranslate(urn) {
    const token = await getAccessToken('data:write data:read');

    // Check existing translation
    const existing = await getManifest(token, urn);
    if (existing) {
        if (existing.status === 'success') {
            console.log('Model already translated.');
            const derivatives = findDerivatives(existing);
            console.log(`  Derivatives: ${derivatives.map(d => d.format).join(', ')}`);
            return urn;
        }
        if (existing.status === 'inprogress') {
            console.log('Translation already in progress, waiting...');
            await waitForTranslation(token, urn);
            return urn;
        }
    }

    // Submit new translation
    console.log(`Submitting translation job for URN: ${urn}...`);
    await submitTranslation(token, urn);
    console.log('Waiting for translation to complete...');
    await waitForTranslation(token, urn);
    console.log('Translation complete!');
    return urn;
}

async function cmdConvert(urn, outputDir) {
    const authProvider = new TwoLeggedAuthenticationProvider(APS_CLIENT_ID, APS_CLIENT_SECRET);

    // Get manifest to find SVF derivatives
    const token = await getAccessToken('viewables:read data:read');
    const manifest = await getManifest(token, urn);
    if (!manifest || manifest.status !== 'success') {
        throw new Error('Model not translated yet. Run "translate" command first.');
    }

    const derivatives = findDerivatives(manifest);
    if (derivatives.length === 0) {
        throw new Error('No SVF derivatives found in manifest.');
    }

    console.log(`Found ${derivatives.length} derivative(s):`);
    derivatives.forEach(d => console.log(`  ${d.format} (guid: ${d.guid})`));

    fse.ensureDirSync(outputDir);

    for (const derivative of derivatives) {
        if (derivative.format === 'svf') {
            await convertSVF(urn, derivative.guid, authProvider, outputDir);
        }
    }
}

async function convertSVF(urn, guid, authProvider, outputDir) {
    console.log(`\n=== Converting SVF (guid: ${guid}) ===`);
    const reader = await SVFReader.FromDerivativeService(urn, guid, authProvider);

    const tempDir = path.join(outputDir, '.tmp', guid);
    fse.ensureDirSync(tempDir);

    try {
        // Use lazy-loading scene instead of reader.read()
        const scene = new LazySVFScene(reader, tempDir);
        await scene.init();

        const outputGlb = path.join(outputDir, `${guid}.glb`);
        console.log(`  Writing merged GLB to: ${outputGlb}`);

        const writer = new MergingGLTFWriter({
            center: true,
            log: (msg) => console.log(`  [Writer] ${msg}`)
        });
        await writer.write(scene, outputGlb);

        console.log(`  Done! Output: ${outputGlb}`);
    } finally {
        fse.removeSync(path.join(outputDir, '.tmp'));
    }
}

async function cmdAuto(bucketKey, objectKey, outputDir) {
    // Full pipeline: find object → translate → convert
    const token = await getAccessToken('bucket:read data:read data:write');

    // Find object URN
    console.log(`Looking for "${objectKey}" in bucket "${bucketKey}"...`);
    const objects = await listObjects(token, bucketKey);
    const obj = objects.find(o => o.objectKey === objectKey);
    if (!obj) {
        throw new Error(`Object "${objectKey}" not found in bucket "${bucketKey}"`);
    }
    const urn = objectIdToUrn(obj.objectId);
    console.log(`URN: ${urn}`);

    // Translate
    await cmdTranslate(urn);

    // Convert
    await cmdConvert(urn, outputDir);
}

// ---------------------------------------------------------------------------
// CLI Entry Point
// ---------------------------------------------------------------------------

const [,, command, ...args] = process.argv;

(async () => {
    try {
        switch (command) {
            case 'list':
                await cmdList();
                break;
            case 'upload':
                if (args.length < 2) {
                    console.error('Usage: node aps-to-gltf.js upload <bucketKey> <filePath>');
                    process.exit(1);
                }
                await cmdUpload(args[0], args[1]);
                break;
            case 'translate':
                if (args.length < 1) {
                    console.error('Usage: node aps-to-gltf.js translate <urn>');
                    process.exit(1);
                }
                await cmdTranslate(args[0]);
                break;
            case 'convert':
                if (args.length < 2) {
                    console.error('Usage: node aps-to-gltf.js convert <urn> <outputDir>');
                    process.exit(1);
                }
                await cmdConvert(args[0], args[1]);
                break;
            case 'auto':
                if (args.length < 3) {
                    console.error('Usage: node aps-to-gltf.js auto <bucketKey> <objectKey> <outputDir>');
                    process.exit(1);
                }
                await cmdAuto(args[0], args[1], args[2]);
                break;
            default:
                console.log('APS OSS → SVF → GLB Converter (memory-efficient, merged meshes)\n');
                console.log('Usage: node aps-to-gltf.js <command> [args]\n');
                console.log('Commands:');
                console.log('  list                                List OSS buckets and objects');
                console.log('  upload <bucket> <file>              Upload file to OSS');
                console.log('  translate <urn>                     Translate model to SVF');
                console.log('  convert <urn> <outputDir>           Convert SVF to merged GLB');
                console.log('  auto <bucket> <object> <outputDir>  Full pipeline\n');
                console.log('Environment:');
                console.log('  APS_CLIENT_ID');
                console.log('  APS_CLIENT_SECRET');
        }
    } catch (err) {
        console.error(`Error: ${err.message || err}`);
        if (err.response) {
            console.error(`  HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}`);
        }
        process.exit(1);
    }
})();
