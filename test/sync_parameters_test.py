import contextlib
import shutil
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import os
import textwrap
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("sync", Path(__file__).resolve().parents[1] / "scripts/sync_parameters.py")
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)


class SyncTest(unittest.TestCase):
    def setUp(self):
        mongo = json.dumps({"MONGO_URI": "mongodb+srv://sensitive/$user:p@host/db?x=1&y=2", "ORIGIN_VERIFY_SECRET": "x" * 32}, ensure_ascii=False)
        self.env = {"GITHUB_REPOSITORY": "matigaleanodev/foodly-notes-api-cloud", "GITHUB_REF": "refs/heads/dev",
                    "GITHUB_EVENT_NAME": "workflow_dispatch", "PARAMETERS_ENVIRONMENT": "production-parameters",
                    "AWS_REGION": "us-east-1", "PARAMETER": "all", "FOODLY_HEALTH_MONGO_JSON": mongo, "FOODLY_MONGO_JSON": mongo,
                    "FOODLY_PROVIDERS_JSON": json.dumps({"SPOONACULAR_API_KEY": "sensitive\n$()\"é", "AZURE_TRANSLATOR_KEY": "sensitive", "AZURE_TRANSLATOR_REGION": "eastus"}, ensure_ascii=False)}
        self.identity = {"Account": "650387442642", "Arn": "arn:aws:sts::650387442642:assumed-role/foodly-notes-test-parameters-sync/run"}

    def test_preserves_original_json_and_special_characters(self):
        self.env["FOODLY_PROVIDERS_JSON"] += "\n\n"
        requests, paths = [], []
        def execute(command, **kwargs):
            self.assertNotIn("input", kwargs)
            if "put-parameter" not in command:
                return subprocess.CompletedProcess([], 0, json.dumps(self.identity), "")
            path = Path(command[command.index("--cli-input-json") + 1].removeprefix("file://"))
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertNotIn("sensitive", " ".join(command))
            requests.append(json.loads(path.read_text()))
            paths.append(path)
            return subprocess.CompletedProcess([], 0, '{"Version": 7}', "")
        with patch.object(sync.subprocess, "run", side_effect=execute), contextlib.redirect_stdout(io.StringIO()) as output:
            sync.main(self.env)
        self.assertTrue(all(not path.exists() for path in paths))
        self.assertEqual([item["Value"] for item in requests], [self.env["FOODLY_HEALTH_MONGO_JSON"], self.env["FOODLY_MONGO_JSON"], self.env["FOODLY_PROVIDERS_JSON"]])
        self.assertTrue(all(item["Type"] == "SecureString" and item["Tier"] == "Standard" and item["KeyId"] == "alias/aws/ssm" for item in requests))
        self.assertNotIn("sensitive", output.getvalue())
        self.assertEqual(output.getvalue().count("version 7 (updated)"), 3)

    @unittest.skipUnless(shutil.which("aws"), "AWS CLI unavailable")
    def test_real_cli_loads_payload_without_aws_calls(self):
        with patch.dict(os.environ, {"AWS_CONFIG_FILE": "/dev/null", "AWS_SHARED_CREDENTIALS_FILE": "/dev/null", "AWS_ACCESS_KEY_ID": "fixture", "AWS_SECRET_ACCESS_KEY": "fixture", "AWS_EC2_METADATA_DISABLED": "true"}):
            result = sync.aws("ssm", "put-parameter", "--generate-cli-skeleton", "output", "--endpoint-url", "http://127.0.0.1:9", request={"Name": "/foodly-notes/test/providers", "Value": self.env["FOODLY_PROVIDERS_JSON"], "Type": "SecureString", "Tier": "Standard", "Overwrite": True})
        self.assertEqual(result["Version"], 0)

    def test_selective_update_needs_no_other_secrets(self):
        self.env["PARAMETER"] = "providers"
        del self.env["FOODLY_MONGO_JSON"], self.env["FOODLY_HEALTH_MONGO_JSON"]
        self.assertEqual(sync.payloads(self.env), [("/foodly-notes/test/providers", self.env["FOODLY_PROVIDERS_JSON"])])

    def test_origin_update_leaves_providers_untouched(self):
        self.env["PARAMETER"] = "mongo-domains"
        del self.env["FOODLY_PROVIDERS_JSON"]
        self.assertEqual(len(sync.payloads(self.env)), 2)
        self.env["FOODLY_MONGO_JSON"] = json.dumps({"MONGO_URI": "mongodb://fixture", "ORIGIN_VERIFY_SECRET": "y" * 32})
        with self.assertRaises(ValueError):
            sync.payloads(self.env)

    def test_validates_all_payloads_before_any_aws_call(self):
        for invalid in ("", " ", "invalid-sensitive", 'NaN', '{"SPOONACULAR_API_KEY":"a","AZURE_TRANSLATOR_KEY":"b","AZURE_TRANSLATOR_REGION":"c","ignored":NaN}', "[]", "{}", '{"SPOONACULAR_API_KEY":7}', "x" * 4097):
            with self.subTest(invalid=invalid[:20]), patch.object(sync, "aws") as aws:
                self.env["FOODLY_PROVIDERS_JSON"] = invalid
                with self.assertRaises(ValueError) as error:
                    sync.main(self.env)
                self.assertNotIn("sensitive", str(error.exception))
                aws.assert_not_called()

    def test_wrong_context_never_calls_aws(self):
        for key in ("GITHUB_REPOSITORY", "GITHUB_REF", "GITHUB_EVENT_NAME", "PARAMETERS_ENVIRONMENT", "AWS_REGION", "PARAMETER"):
            with self.subTest(key=key), patch.object(sync, "aws") as aws:
                with self.assertRaises(ValueError):
                    sync.main({**self.env, key: "invalid"})
                aws.assert_not_called()

    def test_wrong_account_or_role_never_writes(self):
        for identity in ({**self.identity, "Account": "111111111111"}, {**self.identity, "Arn": "arn:aws:sts::650387442642:assumed-role/admin/run"}):
            with patch.object(sync, "aws", return_value=identity) as aws:
                with self.assertRaises(ValueError):
                    sync.main(self.env)
                self.assertEqual(aws.call_count, 1)

    def test_aws_diagnostics_never_escape(self):
        with patch.object(sync.subprocess, "run", return_value=subprocess.CompletedProcess([], 1, "sensitive", "mongodb://sensitive")):
            with self.assertRaisesRegex(ValueError, "^AWS operation failed.$"):
                sync.aws("ssm", "put-parameter", request={"Value": "sensitive"})

    def test_partial_failure_reports_only_completed_parameters(self):
        with patch.object(sync, "aws", side_effect=[self.identity, {"Version": 2}, ValueError("AWS operation failed.")]) as aws, contextlib.redirect_stdout(io.StringIO()) as output:
            with self.assertRaises(ValueError):
                sync.main(self.env)
            self.assertEqual(aws.call_count, 3)
        self.assertEqual(output.getvalue(), "/foodly-notes/test/mongo-health: version 2 (updated)\n")


class FoundationGuardTest(unittest.TestCase):
    def test_only_detaches_retained_legacy_secrets(self):
        root = Path(__file__).resolve().parents[1]
        source = (root / ".github/workflows/foundation.yml").read_text().split("python3 - <<'PY'\n", 1)[1].split("\n          PY", 1)[0]
        source = textwrap.dedent(source)
        old = {"Type": "AWS::SecretsManager::Secret", "DeletionPolicy": "Retain", "UpdateReplacePolicy": "Retain", "Properties": {"Name": "foodly-notes/test/mongo-health"}}
        resource = {"ResourceType": "AWS::SecretsManager::Secret", "Action": "Remove", "LogicalResourceId": "mongohealth"}
        change = {"Status": "CREATE_COMPLETE", "ExecutionStatus": "AVAILABLE", "Changes": [{"ResourceChange": resource}]}
        with tempfile.TemporaryDirectory() as directory:
            original = Path.cwd()
            try:
                os.chdir(directory)
                Path("cdk.foundation.out").mkdir()
                Path("cdk.foundation.out/FoodlyNotesFoundation.template.json").write_text('{"Resources":{}}')
                Path("prepared-template.json").write_text('{"TemplateBody":{"Resources":{}}}')
                def review():
                    Path("foundation-review.json").write_text(json.dumps(change))
                    Path("previous-template.json").write_text(json.dumps({"TemplateBody": {"Resources": {"mongohealth": old}}}))
                    exec(source, {})
                review()
                for key in ("DeletionPolicy", "UpdateReplacePolicy"):
                    old[key] = "Delete"
                    with self.assertRaises(AssertionError):
                        review()
                    old[key] = "Retain"
                resource["LogicalResourceId"] = "unrelated"
                with self.assertRaises(AssertionError):
                    review()
                resource.update(ResourceType="AWS::IAM::Role", Action="Remove")
                with self.assertRaises(AssertionError):
                    review()
                resource.update(Action="Modify", Replacement="True")
                with self.assertRaises(AssertionError):
                    review()
            finally:
                os.chdir(original)


if __name__ == "__main__":
    unittest.main()
