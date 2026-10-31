"""Publish selected, complete JSON payloads without reading existing credentials."""
import json
import os
import subprocess
import sys
import tempfile

PARAMETERS = {
    "mongo-health": ("FOODLY_HEALTH_MONGO_JSON", ["MONGO_URI", "ORIGIN_VERIFY_SECRET"]),
    "mongo": ("FOODLY_MONGO_JSON", ["MONGO_URI", "ORIGIN_VERIFY_SECRET"]),
    "providers": ("FOODLY_PROVIDERS_JSON", ["SPOONACULAR_API_KEY", "AZURE_TRANSLATOR_KEY", "AZURE_TRANSLATOR_REGION"]),
}


def reject_constant(_value):
    raise ValueError("Nonstandard JSON constant.")


def payloads(env):
    selected = env.get("PARAMETER", "")
    if selected not in ["all", "mongo-domains", *PARAMETERS]:
        raise ValueError("Invalid parameter selection.")
    result = []
    for segment, (secret, fields) in PARAMETERS.items():
        if selected not in ("all", segment) and not (selected == "mongo-domains" and segment != "providers"):
            continue
        raw = env.get(secret, "")
        if not raw.strip() or len(raw.encode("utf-8")) > 4096:
            raise ValueError(f"Missing or oversized {secret}; no parameters written.")
        try:
            value = json.loads(raw, parse_constant=reject_constant)
        except (ValueError, TypeError):
            raise ValueError(f"Invalid JSON in {secret}; no parameters written.") from None
        if not isinstance(value, dict) or any(
            not isinstance(value.get(field), str) or not value[field].strip() for field in fields
        ):
            raise ValueError(f"Invalid fields in {secret}; no parameters written.")
        if "ORIGIN_VERIFY_SECRET" in fields and len(value["ORIGIN_VERIFY_SECRET"]) < 32:
            raise ValueError(f"Invalid origin secret in {secret}; no parameters written.")
        result.append((f"/foodly-notes/test/{segment}", raw))
    if selected in ("all", "mongo-domains"):
        origins = [json.loads(raw)["ORIGIN_VERIFY_SECRET"] for name, raw in result if name.endswith(("/mongo", "/mongo-health"))]
        if len(set(origins)) != 1:
            raise ValueError("Mongo domains must share the same origin secret; no parameters written.")
    return result


def aws(*args, request=None):
    command = ["aws", *args, "--region", "us-east-1", "--output", "json", "--no-cli-pager"]
    if request is None:
        result = subprocess.run(command, text=True, capture_output=True, check=False)
    else:
        # AWS CLI cannot reliably load cli-input-json from /dev/stdin.
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", prefix="foodly-parameters-", dir=os.environ.get("RUNNER_TEMP")) as payload:
            json.dump(request, payload)
            payload.flush()
            result = subprocess.run(command + ["--cli-input-json", "file://" + payload.name], text=True, capture_output=True, check=False)
    if result.returncode:
        # CLI diagnostics can include sensitive request data. Never forward them.
        raise ValueError("AWS operation failed.")
    try:
        return json.loads(result.stdout)
    except ValueError:
        raise ValueError("Invalid AWS response.") from None


def main(env):
    if (env.get("GITHUB_REPOSITORY") != "matigaleanodev/foodly-notes-api-cloud"
        or env.get("GITHUB_REF") != "refs/heads/dev"
        or env.get("GITHUB_EVENT_NAME") != "workflow_dispatch"
        or env.get("PARAMETERS_ENVIRONMENT") != "production-parameters"
        or env.get("AWS_REGION") != "us-east-1"):
        raise ValueError("Invalid repository, branch, event, environment or region.")
    pending = payloads(env)
    identity = aws("sts", "get-caller-identity")
    if (identity.get("Account") != "650387442642" or not identity.get("Arn", "").startswith(
        "arn:aws:sts::650387442642:assumed-role/foodly-notes-test-parameters-sync/"
    )):
        raise ValueError("Invalid AWS identity.")
    for name, raw in pending:
        response = aws("ssm", "put-parameter", request={
            "Name": name, "Value": raw, "Type": "SecureString", "Tier": "Standard",
            "KeyId": "alias/aws/ssm", "Overwrite": True,
        })
        version = response.get("Version")
        if type(version) is not int or version < 1:
            raise ValueError("Invalid parameter version.")
        message = f"{name}: version {version} (updated)"
        print(message, flush=True)
        if env.get("GITHUB_STEP_SUMMARY"):
            with open(env["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as summary:
                summary.write(message + "\n")


if __name__ == "__main__":
    try:
        main(os.environ)
    except ValueError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
