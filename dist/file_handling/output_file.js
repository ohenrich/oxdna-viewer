function makeOutputFiles() {
    let name = view.getInputValue("outputFilename");
    let top = view.getInputBool("topDownload");
    let reorganized, counts;
    if (top) {
        let { a, b, file_name, file } = makeTopFile(name);
        reorganized = a;
        counts = b;
        makeTextFile(file_name, file);
    }
    else if (systems.length > 1 || topologyEdited) {
        notify("You have edited the topology of the scene, a new topology file must be generated", "warning");
        return;
    }
    let dat = view.getInputBool("datDownload");
    if (dat) {
        console.log(reorganized);
        let { file_name, file } = makeDatFile(name, reorganized);
        makeTextFile(file_name, file);
    }
    if (ANMs.length > 0) {
        let { file_name, file } = makeParFile(name, reorganized, counts);
        makeTextFile(file_name, file);
    }
}
function makeArrayBuffer(buffer, filename) {
    var link = document.createElement('a');
    link.style.display = 'none';
    document.body.appendChild(link); // Firefox workaround, see #6594 threejs
    let blob = new Blob([buffer], { type: 'application/octet-stream' });
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
}
function make3dOutput() {
    const name = view.getInputValue("3dExportFilename");
    const fileFormat = view.getInputValue("3dExportFormat");
    const include_backbone = view.getInputBool("includeBackbone");
    const include_nucleoside = view.getInputBool("includeNucleoside");
    const include_connector = view.getInputBool("includeConnector");
    const include_bbconnector = view.getInputBool("includeBBconnector");
    const flattenHierarchy = view.getInputBool("3dExportFlat");
    const faces_mul = view.getInputNumber("3dExportFacesMul");
    const stl_scale = view.getInputNumber("3dExportScale");
    if (fileFormat === 'stl') {
        saveSTL(name, include_backbone, include_nucleoside, include_connector, include_bbconnector, stl_scale, faces_mul);
    }
    else if (fileFormat === 'gltf' || fileFormat === 'glb') {
        let binary = fileFormat === 'glb';
        let objects = exportGLTF(systems, include_backbone, include_nucleoside, include_connector, include_bbconnector, stl_scale, faces_mul, flattenHierarchy);
        var exporter = new GLTFExporter();
        var options = { 'forceIndices': true, 'binary': binary };
        // Parse the input and generate the glTF output
        exporter.parse(objects, function (result) {
            if (result instanceof ArrayBuffer) {
                makeArrayBuffer(result, name + '.glb');
            }
            else {
                var output = JSON.stringify(result);
                makeTextFile(name + '.gltf', output);
            }
        }, options);
    }
    else {
        notify(`Unknown file format: ${fileFormat}`, "alert");
    }
}
function getNewIds() {
    //remove any gaps in the particle numbering
    //have to rebuild the system to keep all proteins contiguous or else oxDNA will segfault
    let peptides = [];
    let nas = [];
    //figure out if there are any proteins in the system
    systems.forEach(system => {
        system.strands.forEach(strand => {
            if (strand.isPeptide()) {
                peptides.push(strand);
            }
            else {
                nas.push(strand);
            }
        });
    });
    const newStrandIds = new Map();
    const newElementIds = new Map();
    let totNuc = 0;
    let totAA = 0;
    let totNucleic = 0;
    let totPeptide = 0;
    let sidCounter = -1;
    let idCounter = 0;
    peptides.forEach(strand => {
        newStrandIds.set(strand, sidCounter--);
        totPeptide += 1;
        strand.forEach((e) => {
            newElementIds.set(e, idCounter++);
            totAA++;
        });
    });
    sidCounter = 1;
    nas.forEach(strand => {
        newStrandIds.set(strand, sidCounter++);
        totNucleic += 1;
        strand.forEach((e) => {
            newElementIds.set(e, idCounter++);
            totNuc++;
        }, true // Iterate in 3' to 5' direction, per oxDNA convention
        );
    });
    const counts = {
        totParticles: totNuc + totAA,
        totStrands: totPeptide + totNucleic,
        totNuc: totNuc,
        totAA: totAA,
        totNucleic: totNucleic
    };
    if (counts.totParticles != elements.size) {
        notify(`Length of totNuc (${counts.totParticles}) is not equal to length of elements array (${elements.size})`);
    }
    return [newElementIds, newStrandIds, counts];
}
function makeTopFile(name) {
    const top = []; // string of contents of .top file
    // remove any gaps in the particle numbering
    let [newElementIds, newStrandIds, counts] = getNewIds();
    let firstLine = [counts['totParticles'], counts['totStrands']];
    // Add extra counts needed in protein simulation
    if (counts['totAA'] > 0) {
        firstLine = firstLine.concat(['totNuc', 'totAA', 'totNucleic'].map(v => counts[v]));
    }
    top.push(firstLine.join(" "));
    newElementIds.forEach((_id, e) => {
        let n3 = e.n3 ? newElementIds.get(e.n3) : -1;
        let n5 = e.n5 ? newElementIds.get(e.n5) : -1;
        let cons = [];
        // Protein mode
        if (counts['totAA'] > 0) {
            for (let i = 0; i < e.connections.length; i++) {
                let c = e.connections[i];
                if (newElementIds.get(c.p2) > newElementIds.get(e) && newElementIds.get(c.p2) != n5) {
                    cons.push(newElementIds.get(c.p2));
                }
            }
        }
        top.push([newStrandIds.get(e.strand), e.type, n3, n5, ...cons].join(' '));
    });
    //makeTextFile(name+".top", top.join("\n")); //make .top 
    //this is absolute abuse of ES6 and I feel a little bad about it
    return { a: newElementIds, b: firstLine, file_name: name + ".top", file: top.join("\n") };
}
function makeDatFile(name, altNumbering = undefined) {
    // Get largest absolute coordinate:
    let maxCoord = 0;
    elements.forEach(e => {
        let p = e.getPos();
        maxCoord = Math.max(maxCoord, Math.max(Math.abs(p.x), Math.abs(p.y), Math.abs(p.z)));
    });
    let dat = "";
    let box = Math.ceil(3 * maxCoord);
    dat = [
        `t = 0`,
        `b = ${box} ${box} ${box}`,
        `E = 0 0 0\n`
    ].join('\n');
    // get coordinates for all elements, in the correct order
    if (altNumbering) {
        altNumbering.forEach((_id, e) => {
            dat += e.getDatFileOutput();
        });
    }
    else {
        systems.forEach(system => {
            system.strands.forEach((strand) => {
                strand.forEach(e => {
                    console.log(e.id);
                    dat += e.getDatFileOutput();
                }, true); //oxDNA runs 3'-5'
            });
        });
    }
    return { file_name: name + ".dat", file: dat }; //make .dat file
}
function makeParFile(name, altNumbering, counts) {
    const par = [];
    par.push(counts[3]);
    ANMs.forEach((anm) => {
        //ANMs can be huge so we need to use a traditional for loop here
        const l = anm.children.length;
        for (let i = 0; i < l; i++) {
            const curCon = anm.children[i];
            const p1ID = altNumbering.get(curCon.p1);
            const p2ID = altNumbering.get(curCon.p2);
            const line = [p1ID, p2ID, curCon.eqDist, curCon.type, curCon.strength].concat(curCon.extraParams);
            par.push(line.join(" "));
        }
    });
    return { file_name: name + ".par", file: par.join('\n') };
}
function writeMutTrapText(base1, base2) {
    return "{\n" + "type = mutual_trap\n" +
        "particle = " + base1 + "\n" +
        "ref_particle = " + base2 + "\n" +
        "stiff = 0.09\n" +
        "r0 = 1.2 \n" +
        "PBC = 1" + "\n}\n\n";
}
function makeForceFile() {
    if (forces.length > 0) {
        makeTextFile("external_forces.txt", forcesToString());
    }
    else {
        notify("No forces have been added yet, please click Dynamics/Forces", "alert");
    }
}
function makeSelectedBasesFile() {
    makeTextFile("baseListFile", Array.from(selectedBases).map(e => e.id).join(" "));
}
function makeSequenceFile() {
    let seqTxts = [];
    systems.forEach((sys) => {
        sys.strands.forEach((strand) => {
            let label = strand.label ? strand.label : `strand_${strand.id}`;
            seqTxts.push(`${label}, ${strand.getSequence()}`);
        });
    });
    makeTextFile("sequences.csv", seqTxts.join("\n"));
}
function makeOxViewJsonFile(space) {
    makeTextFile("output.oxview", JSON.stringify({
        date: new Date(),
        box: box.toArray(),
        systems: systems,
        forces: forces
    }, null, space));
}
//let textFile: string;
function makeTextFile(filename, text) {
    let blob = new Blob([text], { type: 'text' });
    var elem = window.document.createElement('a'); //
    elem.href = window.URL.createObjectURL(blob); //
    elem.download = filename; //
    document.body.appendChild(elem); //
    elem.click(); //
    document.body.removeChild(elem); //
    //window.parent.FakeDataDownload(blob, filename);
}
;
