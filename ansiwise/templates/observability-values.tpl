# The three URL defines the alert mail template calls, carrying this installation's own address.
#
# WRITTEN PER INSTALLATION BECAUSE HELM CANNOT WRITE THEM. The chart puts every entry of
# alertmanager.templateFiles into its Secret with b64enc alone and never runs helm's tpl over it —
# tpl reaches alertmanager.config, and only because the inventory turns tplConfig on. So an address
# spelled as a Helm expression up there arrives at Alertmanager as its own text, and Alertmanager
# renders it against an alert, where the chart's values do not exist. The substitution has to happen
# before helm reads the tree, which is this file.
#
# A KEY OF ITS OWN, NEVER THE MAIL TEMPLATE'S. Helm merges the map and REPLACES a string, so this
# file written under the key the mail template already stands on would delete the mail template
# instead of completing it. Alertmanager loads every file its config's templates glob names into one
# namespace, so a define here answers a call there.
#
# WITHOUT THIS FILE NO NOTIFICATION IS SENT AT ALL. A call to a define no loaded file declares is a
# template error and not an empty link: Alertmanager cancels the notification, so every alert of the
# installation is dropped and not merely one link in it.
kube-prometheus-stack:
  alertmanager:
    templateFiles:
      alert-urls.tmpl: |-
        {{- /* ALL THREE ARE GRAFANA, because it is the only address a person opens. The
               observability inventory publishes the name grafana under this installation's domain
               and nothing else a browser is meant to reach: Alertmanager carries no Ingress at all,
               and Loki's one public route is the push endpoint a slave writes to behind basic
               auth. */ -}}
        {{- /* THE UID IS `loki` AND THE DISPLAY NAME IS `Loki` — two different strings, both set by
               the inventory's own datasources block. The object form {type,uid} says which of the
               two this is; a bare string leaves that to whichever Grafana reads it, and a pane
               pointed at nothing shows no data rather than an error. */ -}}
        {{- define "alert.loki_url" -}}
        {{- $pane := printf `{"logs":{"datasource":"loki","queries":[{"refId":"A","datasource":{"type":"loki","uid":"loki"},"expr":"{namespace=\"%s\"}"}],"range":{"from":"now-3h","to":"now"}}}` .Labels.namespace -}}
        https://grafana.<fqdn>/explore?schemaVersion=1&panes={{ $pane | urlquery }}
        {{- end -}}

        {{- define "alert.alert_url" -}}
        https://grafana.<fqdn>/alerting/list
        {{- end -}}

        {{- define "alert.silence_url" -}}
        https://grafana.<fqdn>/alerting/silences
        {{- end -}}
