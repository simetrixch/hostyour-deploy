import base64,json,os,re,subprocess,sys,urllib.request,urllib.error,urllib.parse

phase='prepare'
fd=None
vault_token=None
last_http_status=None

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,req,fp,code,msg,headers,newurl):return None

opener=urllib.request.build_opener(NoRedirect())

def vault(path,body,token=None):
    global last_http_status
    last_http_status=None
    headers={'Content-Type':'application/json'}
    if token:headers['X-Vault-Token']=token
    req=urllib.request.Request(vault_address+'/v1/'+path,data=json.dumps(body).encode(),headers=headers,method='POST')
    try:
        with opener.open(req,timeout=20) as response:
            last_http_status=response.status
            raw=response.read()
            return response.status,json.loads(raw) if raw else {}
    except urllib.error.HTTPError as error:
        last_http_status=error.code
        error.close()
        return error.code,{}

try:
    if len(sys.argv)!=4:raise ValueError('invalid_input')
    cluster,guid,stage=sys.argv[1:]
    vault_address=os.environ.get('VAULT_ADDR','').rstrip('/')
    address=urllib.parse.urlsplit(vault_address)
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,62}',cluster) or not re.fullmatch(r'[a-z0-9]{12}',guid) or stage not in ['dev','test','prod']:raise ValueError('invalid_input')
    if address.scheme!='https' or not address.hostname or address.username or address.password or address.query or address.fragment or address.path:raise ValueError('invalid_input')
    namespace=guid+'-auth-'+stage
    k=['microk8s','kubectl']
    phase='cluster_credential'
    secret=json.loads(subprocess.check_output(k+['get','secret','cluster-slave','-n',cluster,'-o','json'],stderr=subprocess.DEVNULL))['data']
    config=json.loads(base64.b64decode(secret['config']))
    server={'server':base64.b64decode(secret['server']).decode()}
    tls=config.get('tlsClientConfig',{})
    if tls.get('caData'):server['certificate-authority-data']=tls['caData']
    if tls.get('insecure'):server['insecure-skip-tls-verify']=True
    client={'apiVersion':'v1','kind':'Config','clusters':[{'name':cluster,'cluster':server}],'users':[{'name':'proof','user':{'token':config['bearerToken']}}],'contexts':[{'name':cluster,'context':{'cluster':cluster,'user':'proof'}}],'current-context':cluster}
    fd=os.memfd_create('tenant-stage-proof',0);os.write(fd,json.dumps(client).encode())
    k+=['--kubeconfig',f'/proc/self/fd/{fd}']
    def kube(args):return subprocess.check_output(k+args,pass_fds=(fd,),stderr=subprocess.DEVNULL)
    phase='namespace_metadata'
    ns=json.loads(kube(['get','namespace',namespace,'-o','json']))
    labels=ns['metadata'].get('labels',{})
    if labels.get('platform/tenant-managed')!='true' or labels.get('platform/tenant-stage')!=stage or labels.get('platform/tenant')!=guid:raise ValueError('namespace_metadata_not_canonical')
    phase='token_request'
    jwt=kube(['create','token','external-secrets-sa','-n',namespace,'--duration=10m']).decode().strip()
    phase='own_stage_vault_login'
    status,login=vault('auth/kubernetes-'+cluster+'/login',{'role':'tenant-eso-'+stage,'jwt':jwt})
    if status!=200:raise ValueError('own_stage_login_http_'+str(status))
    vault_token=login.get('auth',{}).get('client_token')
    if not vault_token:raise ValueError('own_stage_token_missing')
    own_data='secret/data/'+stage+'/tenants/'+guid+'/auth/proof'
    own_metadata='secret/metadata/'+stage+'/tenants/'+guid+'/auth/proof'
    foreign_guid='0'*12 if guid!='0'*12 else '1'*12
    foreign=[{'stage':s,'guid':g,'path':'secret/'+mount+'/'+s+'/tenants/'+g+suffix} for s in ['dev','test','prod'] for g in [guid,foreign_guid] if s!=stage or g!=guid for mount in ['data','metadata'] for suffix in ['', '/auth/proof']]
    own_paths=[own_data.rsplit('/auth/proof',1)[0],own_metadata.rsplit('/auth/proof',1)[0],own_data,own_metadata]
    paths=own_paths+[p['path'] for p in foreign]+['secret/data/prod/app/registry']
    phase='capabilities_metadata'
    status,result=vault('sys/capabilities-self',{'paths':paths},vault_token)
    if status!=200:raise ValueError('capabilities_metadata_http_'+str(status))
    denied=all(result.get(p['path'])==['deny'] for p in foreign)
    own_read=all(result.get(path)==['read'] if path.startswith('secret/data/') else sorted(result.get(path,[]))==['list','read'] for path in own_paths)
    registry_read=result.get('secret/data/prod/app/registry')==['read']
    wrong_roles=[]
    for other in ['dev','test','prod']:
        if other==stage:continue
        phase='wrong_stage_login_'+other
        code,wrong=vault('auth/kubernetes-'+cluster+'/login',{'role':'tenant-eso-'+other,'jwt':jwt})
        wrong_token=wrong.get('auth',{}).get('client_token')
        if wrong_token:
            phase='revoke_wrong_stage_token'
            revoke_status,_=vault('auth/token/revoke-self',{},wrong_token)
            if revoke_status!=204:raise ValueError('token_revoke_failed')
        wrong_roles.append({'requestedStage':other,'http':code,'expectedDenied':code==403})
    proof={'cluster':cluster,'stage':stage,'guid':guid,'namespace':namespace,'ownStageLoginHttp':200,'ownTenantReadMetadataList':own_read,'foreignStageOrGuidDenied':denied,'foreignPathsChecked':len(foreign),'existingRegistryLeafReadOnly':registry_read,'wrongStageRoleLogin':wrong_roles,'secretDataReads':0,'persistentObjectsWritten':0}
    phase='effective_capabilities'
    if not (own_read and denied and registry_read and all(r['expectedDenied'] for r in wrong_roles)):raise ValueError('effective_capabilities_mismatch')
except Exception as error:
    failure={'checks':proof} if phase=='effective_capabilities' else {}
    print(json.dumps({**failure,'phase':phase,'exceptionClass':type(error).__name__,'subprocessExit':getattr(error,'returncode',None),'httpStatus':last_http_status}))
    sys.exit(1)
finally:
    try:
        if vault_token:
            phase='revoke_proof_token'
            revoke_status,_=vault('auth/token/revoke-self',{},vault_token)
            if revoke_status!=204:raise ValueError('token_revoke_failed')
    except Exception as error:
        print(json.dumps({'phase':phase,'exceptionClass':type(error).__name__,'subprocessExit':getattr(error,'returncode',None),'httpStatus':last_http_status}))
        sys.exit(1)
    finally:
        if fd is not None:os.close(fd)
print(json.dumps(proof))
