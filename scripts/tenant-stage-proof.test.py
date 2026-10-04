import contextlib,io,json,os,runpy,subprocess,sys,unittest,urllib.error
from pathlib import Path
from unittest.mock import patch

SCRIPT=Path(__file__).with_name('tenant-stage-proof.py')

class ProofTest(unittest.TestCase):
    def run_proof(self,token_error=False,transport_error=False,revoke_error=False,foreign_metadata_grant=False):
        requested=[];revocations=[]
        def kube(args,**kwargs):
            if 'secret' in args:
                import base64
                data={'server':base64.b64encode(b'https://cluster.example.test').decode(),'config':base64.b64encode(json.dumps({'bearerToken':'opaque-kube-fixture'}).encode()).decode()}
                return json.dumps({'data':data}).encode()
            if 'namespace' in args:
                name=args[args.index('namespace')+1];guid=name.rsplit('-auth-',1)[0];stage=name.rsplit('-',1)[1]
                return json.dumps({'metadata':{'labels':{'platform/tenant-managed':'true','platform/tenant-stage':stage,'platform/tenant':guid}}}).encode()
            if 'token' in args:
                duration=next(x.split('=',1)[1] for x in args if x.startswith('--duration='));requested.append(duration)
                if token_error or int(duration.rstrip('m'))*60<600:
                    raise subprocess.CalledProcessError(1,args,output=b'opaque-jwt-fixture',stderr=b'opaque-kube-fixture spec.expirationSeconds: Invalid value: 300: may not specify a duration less than 10 minutes')
                return b'opaque-jwt-fixture'
            raise AssertionError('unexpected subprocess')
        class Response:
            def __init__(self,status,value):self.status=status;self.value=value
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def read(self):return json.dumps(self.value).encode() if self.value else b''
        def vault(request,**kwargs):
            body=json.loads(request.data)
            if request.full_url.endswith('/login'):
                if transport_error:raise urllib.error.URLError('opaque-jwt-fixture transport failure')
                if body['role']=='tenant-eso-prod':return Response(200,{'auth':{'client_token':'opaque-vault-fixture'}})
                raise urllib.error.HTTPError(request.full_url,403,'expected denied',{},None)
            if request.full_url.endswith('/capabilities-self'):
                paths=body['paths'];caps={p: ['read'] if i==len(paths)-1 or (i<4 and p.startswith('secret/data/')) else ['read','list'] if i<4 else ['deny'] for i,p in enumerate(paths)}
                if foreign_metadata_grant:caps[next(p for p in paths[4:-1] if p.startswith('secret/metadata/'))]=['read']
                return Response(200,caps)
            if request.full_url.endswith('/revoke-self'):
                revocations.append(True)
                if revoke_error:raise urllib.error.URLError('opaque-vault-fixture transport failure')
                return Response(204,{})
            raise AssertionError('unexpected Vault request')
        output=io.StringIO();error=io.StringIO();exit_code=0
        env={'OP8_CLUSTER':'apps2','OP8_STAGE':'prod','VAULT_ADDR':'https://vault.example.test'}
        with patch.dict(os.environ,env),patch.object(sys,'argv',[str(SCRIPT),'apps2','tenant000001','prod']),patch('subprocess.check_output',side_effect=kube),patch('urllib.request.OpenerDirector.open',side_effect=vault),contextlib.redirect_stdout(output),contextlib.redirect_stderr(error):
            try:self.proof_globals=runpy.run_path(str(SCRIPT),run_name='__main__')
            except SystemExit as e:exit_code=e.code if isinstance(e.code,int) else 1
        raw=output.getvalue()+error.getvalue()
        for credential in ['opaque-kube-fixture','opaque-jwt-fixture','opaque-vault-fixture']:self.assertNotIn(credential,raw)
        rows=[json.loads(line) for line in output.getvalue().splitlines()]
        return exit_code,rows,requested,revocations

    def test_supported_token_runs_complete_proof_and_revokes(self):
        code,rows,requested,revoked=self.run_proof()
        self.assertEqual(requested,['10m'])
        self.assertEqual(code,0)
        self.assertTrue(rows[-1]['ownTenantReadMetadataList'])
        self.assertTrue(rows[-1]['foreignStageOrGuidDenied'])
        self.assertTrue(all(r['expectedDenied'] for r in rows[-1]['wrongStageRoleLogin']))
        self.assertEqual(rows[-1]['secretDataReads'],0)
        self.assertEqual(rows[-1]['foreignPathsChecked'],20)
        self.assertEqual(rows[-1]['guid'],'tenant000001')
        self.assertEqual(revoked,[True])

    def test_subprocess_failure_reports_phase_without_credentials(self):
        code,rows,_,_=self.run_proof(token_error=True)
        self.assertEqual(code,1)
        self.assertEqual(rows[-1]['phase'],'token_request')
        self.assertEqual(rows[-1]['exceptionClass'],'CalledProcessError')
        self.assertEqual(rows[-1]['subprocessExit'],1)

    def test_transport_failure_names_login_phase(self):
        code,rows,_,_=self.run_proof(transport_error=True)
        self.assertEqual(code,1)
        self.assertEqual(rows[-1]['phase'],'own_stage_vault_login')
        self.assertEqual(rows[-1]['exceptionClass'],'URLError')

    def test_revoke_failure_is_visible_and_fails(self):
        code,rows,_,revoked=self.run_proof(revoke_error=True)
        self.assertEqual(code,1)
        self.assertEqual(rows[-1]['phase'],'revoke_proof_token')
        self.assertEqual(revoked,[True])

    def test_foreign_metadata_grant_fails_and_revokes(self):
        code,rows,_,revoked=self.run_proof(foreign_metadata_grant=True)
        self.assertEqual(code,1)
        self.assertEqual(rows[-1]['phase'],'effective_capabilities')
        self.assertFalse(rows[-1]['checks']['foreignStageOrGuidDenied'])
        self.assertEqual(revoked,[True])

    def test_redirect_is_rejected_without_forwarding_token_or_get(self):
        import http.server,threading
        self.run_proof()
        visits=[]
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_POST(self):
                visits.append('POST');self.send_response(302)
                self.send_header('Location','/v1/secret/data/fixture');self.end_headers()
            def do_GET(self):
                visits.append('GET');self.send_response(204);self.end_headers()
        server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
        thread=threading.Thread(target=server.serve_forever);thread.start()
        try:
            call=self.proof_globals['vault']
            call.__globals__['vault_address']='http://127.0.0.1:'+str(server.server_port)
            status,_=call('auth/token/revoke-self',{},'opaque-vault-fixture')
            self.assertEqual(status,302)
            self.assertEqual(visits,['POST'])
        finally:
            server.shutdown();server.server_close();thread.join()

    def test_launchers_keep_identical_output_and_exit(self):
        root=SCRIPT.parent
        shell=subprocess.run(['bash',str(root/'tenant-stage-proof.sh')],capture_output=True)
        powershell=subprocess.run(['pwsh','-NoProfile','-File',str(root/'tenant-stage-proof.ps1')],capture_output=True)
        self.assertEqual(shell.returncode,1)
        self.assertEqual(powershell.returncode,shell.returncode)
        self.assertEqual(powershell.stdout,shell.stdout)
        self.assertEqual(powershell.stderr,shell.stderr)

if __name__=='__main__':unittest.main()
