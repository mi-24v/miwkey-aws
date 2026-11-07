import json
import logging
import os
from datetime import datetime, timezone
from aws_io import AwsIO
from certificate import production_validate, staging_validate
from workflow import Engine

# Never let SDK/ACME error bodies or stack traces reach the invocation response or logs.
for name in ('gufo.acme', 'gufo.http', 'boto3', 'botocore', 'urllib3'):
    logger = logging.getLogger(name)
    logger.disabled = True
    logger.propagate = False
    logger.handlers = [logging.NullHandler()]


def handler(event, context):
    try:
        if not isinstance(event, dict) or set(event) - {'mode', 'force', 'staging', 'recovery'}:
            raise ValueError('invalid invocation')
        mode = event.get('mode')
        force, staging = event.get('force', False), event.get('staging', False)
        if type(force) is not bool or type(staging) is not bool:
            raise ValueError('invalid flags')
        io = AwsIO(os.environ)
        def check(value, rehearsal):
            verifier = staging_validate if rehearsal else production_validate
            return verifier(value, os.environ['FQDN'], datetime.now(timezone.utc))
        Engine(io, check, renewal_days=int(os.environ['RENEWAL_DAYS'])).run(mode, force=force, staging=staging, recovery=event.get('recovery'))
        print(json.dumps({'result': 'invocation-complete', 'mode': mode, 'staging': staging}))
        return {'result': 'complete'}
    except Exception:
        # No original exception is chained into the Lambda error response.
        print('{"result":"invocation-failed"}')
        raise RuntimeError('certificate issuer failed; inspect non-secret state and metrics') from None
