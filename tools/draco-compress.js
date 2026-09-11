/**
 * Draco-compress a GLB file using @gltf-transform.
 * Usage: node draco-compress.js <input.glb> <output.glb>
 */
const { NodeIO, PropertyType } = require('@gltf-transform/core');
const { KHRDracoMeshCompression } = require('@gltf-transform/extensions');
const { dedup, prune, quantize, draco } = require('@gltf-transform/functions');
const draco3d = require('draco3dgltf');

const [,, inputPath, outputPath] = process.argv;
if (!inputPath || !outputPath) {
    console.error('Usage: node draco-compress.js <input.glb> <output.glb>');
    process.exit(1);
}

async function compress() {
    console.log('Initializing Draco modules...');
    const io = new NodeIO()
        .registerExtensions([KHRDracoMeshCompression])
        .registerDependencies({
            'draco3d.decoder': await draco3d.createDecoderModule(),
            'draco3d.encoder': await draco3d.createEncoderModule(),
        });

    console.log(`Loading ${inputPath}...`);
    const document = await io.read(inputPath);

    const root = document.getRoot();
    console.log(`Meshes: ${root.listMeshes().length}, Nodes: ${root.listNodes().length}`);

    console.log('Applying dedup + prune + quantize + draco...');
    await document.transform(
        dedup({ propertyTypes: [PropertyType.MATERIAL, PropertyType.MESH] }),
        prune(),
        quantize(),
        draco(),
    );

    console.log(`Writing ${outputPath}...`);
    await io.write(outputPath, document);
    console.log('Done!');
}

compress().catch(err => { console.error(err); process.exit(1); });
