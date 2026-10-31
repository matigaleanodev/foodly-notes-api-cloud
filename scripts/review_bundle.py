#!/usr/bin/env python3
"""Conserva y verifica un assembly local; nunca consulta ni modifica AWS."""
import hashlib
import json
from pathlib import Path
import re
import shutil
import sys


def inventory(root: Path) -> dict[str, str]:
    result = {}
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise ValueError("El bundle no admite enlaces simbólicos")
        if path.is_file() and path != root / "checksums.json":
            relative = path.relative_to(root).as_posix()
            if any(part in {".git", ".aws", "mentor", ".env"} or part.startswith(".env.") for part in path.relative_to(root).parts):
                raise ValueError("Contenido privado inesperado")
            result[relative] = hashlib.sha256(path.read_bytes()).hexdigest()
    return result



def reference_path(assembly: Path, reference: str) -> Path:
    relative = Path(reference)
    if relative.is_absolute() or ".." in relative.parts:
        raise ValueError("Referencia fuera del assembly")
    if any(part in {".git", ".aws", "mentor", ".env"} or part.startswith(".env.") for part in relative.parts):
        raise ValueError("Contenido privado inesperado")
    path = assembly / relative
    if assembly.is_symlink() or not path.exists() or any((assembly / Path(*relative.parts[:index])).is_symlink() for index in range(1, len(relative.parts) + 1)):
        raise ValueError("Referencia inexistente o enlace simbólico")
    return path


def create(root: Path, output: Path, revision: str, node_version: str) -> None:
    if not re.fullmatch(r"[a-f0-9]{40}", revision):
        raise ValueError("Se requiere un SHA completo")
    if node_version != "v" + (root / ".nvmrc").read_text().strip():
        raise ValueError("Node no coincide con .nvmrc")
    if output.exists():
        raise ValueError("El destino debe ser nuevo")
    assembly = root / "cdk.out"
    manifest = json.loads(reference_path(assembly, "manifest.json").read_text())
    stacks = [(key, value) for key, value in manifest["artifacts"].items() if value["type"] == "aws:cloudformation:stack"]
    if len(stacks) != 1 or stacks[0][0] != "FoodlyNotesTest" or stacks[0][1]["environment"] != "aws://650387442642/us-east-1":
        raise ValueError("Assembly fuera de test")

    references = {"manifest.json"}
    asset_manifests = 0
    for artifact in manifest["artifacts"].values():
        if "additionalMetadataFile" in artifact:
            references.add(artifact["additionalMetadataFile"])
        properties = artifact.get("properties", {})
        references.update(properties[key] for key in ("templateFile", "file") if key in properties)
        if artifact["type"] == "cdk:asset-manifest":
            asset_manifests += 1
            assets = json.loads(reference_path(assembly, properties["file"]).read_text())
            if assets.get("dockerImages"):
                raise ValueError("No se admiten assets Docker")
            references.update(asset["source"]["path"] for asset in assets.get("files", {}).values())
    if asset_manifests != 1:
        raise ValueError("Se requiere el manifest de assets de la stack test")
    for reference in references:
        path = reference_path(assembly, reference)
        if path.is_dir():
            inventory(path)
    for reference in sorted(references):
        source, target = assembly / reference, output / "cdk.out" / reference
        target.parent.mkdir(parents=True, exist_ok=True)
        if source.is_dir():
            shutil.copytree(source, target)
        else:
            shutil.copyfile(source, target)
    shutil.copyfile(root / "package-lock.json", output / "package-lock.json")
    (output / "review.json").write_text(json.dumps({
        "schemaVersion": 1, "revision": revision, "nodeVersion": node_version,
        "stack": "foodly-notes-api-cloud-test", "account": "650387442642", "region": "us-east-1",
        "scope": "candidate-review", "environment": "test",
    }, indent=2) + "\n")
    (output / "checksums.json").write_text(json.dumps(inventory(output), indent=2) + "\n")


def verify(output: Path, revision: str) -> None:
    expected = json.loads((output / "checksums.json").read_text())
    if not expected or inventory(output) != expected:
        raise ValueError("El bundle tiene archivos alterados, faltantes o adicionales")
    assembly = output / "cdk.out"
    manifest = json.loads(reference_path(assembly, "manifest.json").read_text())
    for artifact in manifest["artifacts"].values():
        if "additionalMetadataFile" in artifact:
            reference_path(assembly, artifact["additionalMetadataFile"])
        properties = artifact.get("properties", {})
        for key in ("templateFile", "file"):
            if key in properties:
                reference_path(assembly, properties[key])
        if artifact["type"] == "cdk:asset-manifest":
            assets = json.loads(reference_path(assembly, properties["file"]).read_text())
            for asset in assets.get("files", {}).values():
                reference_path(assembly, asset["source"]["path"])
    review = json.loads((output / "review.json").read_text())
    if review.get("nodeVersion") != "v" + Path(".nvmrc").read_text().strip():
        raise ValueError("Node no coincide con .nvmrc")
    if not re.fullmatch(r"[a-f0-9]{40}", revision) or review["revision"] != revision:
        raise ValueError("La revisión no coincide")


if __name__ == "__main__":
    try:
        if len(sys.argv) == 6 and sys.argv[1] == "create":
            create(Path(sys.argv[2]), Path(sys.argv[3]), sys.argv[4], sys.argv[5])
        elif len(sys.argv) == 4 and sys.argv[1] == "verify":
            verify(Path(sys.argv[2]), sys.argv[3])
        else:
            raise ValueError("Uso: create ROOT OUTPUT SHA NODE | verify OUTPUT SHA")
        print("Bundle local verificado; sin operaciones AWS.")
    except (ValueError, OSError, KeyError, TypeError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
