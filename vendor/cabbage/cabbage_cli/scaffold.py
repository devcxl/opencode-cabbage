from __future__ import annotations
import shutil
from importlib import resources
from pathlib import Path
import re
from .core import (CabbageError, dump_yaml, load_config, load_yaml, change_dir, now_iso,
                   project_root, workflow, condition_enabled, write_text_atomic, CABBAGE_DIR)

IMPACT_FIELD_LABELS={
  "product":"Product","design":"Design","architecture":"Architecture","rfc":"RFC","api":"API","database":"Database",
  "security":"Security","testing":"Testing","deployment":"Deployment","operations":"Operations",
  "performance":"Performance"
}
IMPACT_FIELDS=list(IMPACT_FIELD_LABELS)

ADOPTION_IGNORED_DIRS={".git",".cabbage",".github",".idea",".vscode",".venv","venv","node_modules","__pycache__","dist","build","target","coverage","site",".cache",".temp",".vitepress",".vuepress","vendor"}

ADOPTION_CATEGORY_RULES=[
    ("adr",{"adr"}),
    ("rfc",{"rfc","proposal","proposals"}),
    ("incident",{"incident","incidents","postmortem","postmortems","retrospective","retro"}),
    ("api",{"api","apis","openapi","swagger","webhook","webhooks"}),
    ("data",{"database","databases","db","schema","schemas","migration","migrations","erd","datamodel","domain","domains"}),
    ("security",{"security","threat","threats"}),
    ("testing",{"test","tests","testing","qa","e2e"}),
    ("infrastructure",{"infrastructure","infra","kubernetes","k8s","terraform","helm","ansible"}),
    ("ci-cd",{"ci","cd","pipeline","pipelines","jenkins"}),
    ("release",{"release","releases","changelog","changelogs"}),
    ("operations",{"runbook","runbooks","oncall","operations","ops","monitoring","alerting","observability","slo","sli"}),
    ("performance",{"performance","benchmark","benchmarks","load"}),
    ("product",{"prd","requirement","requirements","user-story","user-stories","product","roadmap"}),
    ("architecture",{"architecture","system-design","tech-design","design","design-doc"}),
    ("development",{"development","contributing","onboarding","setup","installation","getting-started"}),
    ("compliance",{"compliance","policy","policies","governance"}),
    ("overview",{"overview","about","introduction","readme"}),
]

ADOPTION_TARGET_BY_CATEGORY={
    "adr":"docs/03-architecture/adr","rfc":"docs/03-architecture/rfc","incident":"docs/15-incidents",
    "product":"docs/01-product","architecture":"docs/03-architecture","data":"docs/04-domain","api":"docs/05-api",
    "development":"docs/06-development","testing":"docs/08-testing","security":"docs/09-security",
    "infrastructure":"docs/10-infrastructure","ci-cd":"docs/11-ci-cd","release":"docs/12-release",
    "operations":"docs/13-operations","performance":"docs/14-performance","compliance":"docs/17-compliance",
    "overview":"docs/00-overview",
}

ADOPTION_HISTORICAL={"adr","rfc","incident"}

ADOPTION_CONFORMING_AREAS={
    "00":"overview","01":"product","02":"design","03":"architecture","04":"data","05":"api",
    "06":"development","07":"standards","08":"testing","09":"security","10":"infrastructure",
    "11":"ci-cd","12":"release","13":"operations","14":"performance","15":"incident","16":"dependencies","17":"compliance",
}

ALL_CONFORMING_DIRS = [
    "00-overview", "01-product", "02-design", "03-architecture/adr", "03-architecture/rfc",
    "03-architecture/system-design", "04-domain", "05-api", "06-development", "07-standards",
    "08-testing", "09-security", "10-infrastructure", "11-ci-cd", "12-release",
    "13-operations", "14-performance", "15-incidents", "16-dependencies", "17-compliance"
]

def asset(path: str):
    return resources.files("cabbage_cli").joinpath("assets", path)

def copy_asset_tree(src_rel: str, dst: Path, overwrite: bool=False):
    src=asset(src_rel)
    dst.mkdir(parents=True,exist_ok=True)
    for item in src.iterdir():
        target=dst/item.name
        if item.is_dir(): copy_asset_tree(f"{src_rel}/{item.name}", target, overwrite)
        elif overwrite or not target.exists():
            target.write_bytes(item.read_bytes())

def init_project(root: Path, force: bool=False, vendor_cli: bool=True):
    d=root/CABBAGE_DIR
    if (d/"config.yaml").exists() and not force:
        raise CabbageError(f"{CABBAGE_DIR} already initialized; use --force to refresh missing scaffold files")
    d.mkdir(parents=True,exist_ok=True)
    cfg={
      "version":1,
      "impact_fields":IMPACT_FIELDS,
      "ci":{
        "require_change_for_code":True,
        "require_current_state_docs":True,
        "exclude_prefixes":["docs/",".cabbage/",".github/","README","LICENSE"],
        "current_state_rules":{
          "product":["docs/01-product/"],
          "architecture":["docs/03-architecture/"],
          "api":["docs/05-api/"],
          "database":["docs/04-domain/"],
          "security":["docs/09-security/"],
          "testing":["docs/08-testing/"],
          "deployment":["docs/10-infrastructure/","docs/11-ci-cd/","docs/12-release/"],
          "operations":["docs/13-operations/"],
          "performance":["docs/14-performance/"]
        }
      },
      "docs":{"dir":"docs"}
    }
    dump_yaml(d/"config.yaml",cfg)
    copy_asset_tree("workflows",d/"workflows",overwrite=force)
    (d/"changes").mkdir(exist_ok=True); (d/"archive").mkdir(exist_ok=True)
    copy_asset_tree("docs-site",root/"docs",overwrite=False)
    # current-state doc skeleton
    for name in ALL_CONFORMING_DIRS:
        (root/"docs"/name).mkdir(parents=True,exist_ok=True)
    # CI template
    gh=root/".github/workflows"; gh.mkdir(parents=True,exist_ok=True)
    ci=asset("integrations/cabbage.yml").read_text(encoding="utf-8")
    cip=gh/"cabbage.yml"
    if not cip.exists(): cip.write_text(ci,encoding="utf-8")
    gi=root/".gitignore"
    ignores=["docs/node_modules/","docs/.vitepress/cache/","docs/.vitepress/dist/"]
    existing=gi.read_text(encoding="utf-8") if gi.exists() else ""
    add=[x for x in ignores if x not in existing.splitlines()]
    if add:
        with gi.open("a",encoding="utf-8") as f:
            if existing and not existing.endswith("\n"): f.write("\n")
            f.write("\n# cabbage / VitePress\n"+"\n".join(add)+"\n")
    if vendor_cli:
        sync_vendored_cli(root)

def sync_vendored_cli(root: Path):
    """Regenerate the repository-local CLI from the installed source package."""
    pkg = Path(__file__).resolve().parent
    target = root / CABBAGE_DIR / "tooling/cabbage_cli"
    if pkg == target.resolve():
        raise CabbageError("cannot refresh vendored CLI from itself; use the source package")
    if target.exists():
        shutil.rmtree(target)
    shutil.copytree(pkg, target, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))

def render_template(stage: dict, change_id: str, change_type: str) -> str:
    template=stage.get("template","generic.md")
    txt=asset(f"templates/{template}").read_text(encoding="utf-8")
    return txt.replace("{{CHANGE_ID}}",change_id).replace("{{STAGE_ID}}",stage["id"]).replace("{{CHANGE_TYPE}}",change_type)

def sync_impact_document(root: Path, change_id: str):
    p=change_dir(root,change_id)/"impact.md"
    if not p.exists(): return
    spec=load_yaml(change_dir(root,change_id)/"change.yaml")
    text=p.read_text(encoding="utf-8")
    for key,label in IMPACT_FIELD_LABELS.items():
        val="Yes" if spec.get("impact",{}).get(key,False) else "No"
        pattern=rf"^(\|\s*{re.escape(label)}\s*\|)\s*(Yes|No)\s*(\|.*)$"
        text=re.sub(pattern,rf"\1 {val} \3",text,flags=re.M|re.I)
    write_text_atomic(p,text,encoding="utf-8")

def ensure_artifacts(root: Path, change_id: str):
    spec=load_yaml(change_dir(root,change_id)/"change.yaml")
    wf,_=workflow(root,spec["type"])
    for st in wf.get("stages",[]):
        if condition_enabled(st,spec) and st.get("artifact"):
            p=change_dir(root,change_id)/st["artifact"]
            if not p.exists():
                p.parent.mkdir(parents=True,exist_ok=True)
                p.write_text(render_template(st,change_id,spec["type"]),encoding="utf-8")
    sync_impact_document(root,change_id)

def new_change(root: Path, change_type: str, change_id: str):
    cfg=load_config(root)
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*",change_id):
        raise CabbageError("change id must be kebab-case")
    workflow(root,change_type)  # raises `unknown change type` when missing
    d=change_dir(root,change_id)
    if d.exists(): raise CabbageError(f"change already exists: {change_id}")
    d.mkdir(parents=True)
    spec={"id":change_id,"type":change_type,"status":"active","impact":{k:False for k in cfg.get("impact_fields",[])}}
    # Defaults declare only impacts the workflow can produce evidence for; the rest stay false for explicit opt-in.
    # Legacy types keep their defaults so existing projects behave exactly as before the new-project model.
    if change_type!="incident": spec["impact"]["testing"]=True
    if change_type=="change" or change_type=="feature": spec["impact"]["product"]=True
    if change_type=="architecture": spec["impact"]["architecture"]=True
    if change_type in {"migration"}: spec["impact"]["database"]=True; spec["impact"]["deployment"]=True
    if change_type=="integration": spec["impact"]["api"]=True
    dump_yaml(d/"change.yaml",spec)
    ensure_artifacts(root,change_id)

def iter_adoption_docs(root: Path):
    docs_name=load_config(root).get("docs",{}).get("dir","docs")
    for p in sorted(root.rglob("*.md")):
        rel=p.relative_to(root)
        parts=rel.parts
        if not parts or parts[0] in ADOPTION_IGNORED_DIRS or parts[0].startswith("."):
            continue
        if parts[0]==docs_name:
            if conforming_area(rel,docs_name):
                yield rel
            continue
        if any(part in ADOPTION_IGNORED_DIRS for part in parts[:-1]):
            continue
        if p.name.upper()=="README.md" and len(parts)==1:
            continue
        yield rel

def classify_adoption_doc(rel: Path) -> tuple[str,str|None,str|None]:
    name_parts=[p.lower() for p in rel.with_suffix("").parts]
    category=next((c for c,hints in ADOPTION_CATEGORY_RULES if any(h in name_parts for h in hints)),None)
    if category is None:
        lowered="/".join(name_parts)
        category=next((c for c,hints in ADOPTION_CATEGORY_RULES
                       if any(re.search(rf"(^|[-_/]){re.escape(h)}([-_/]|$)",lowered) for h in hints)),None)
    if category is None:
        return "review",None,None
    action="import" if category in ADOPTION_HISTORICAL else "migrate"
    return action,category,ADOPTION_TARGET_BY_CATEGORY[category]

def conforming_area(rel: Path, docs_name: str|None=None) -> str|None:
    parts=rel.parts
    if docs_name and parts and parts[0]==docs_name:
        parts=parts[1:]
    first=parts[0] if parts else ""
    m=re.match(r"^(\d{2})-",first)
    if m and m.group(1) in ADOPTION_CONFORMING_AREAS:
        return ADOPTION_CONFORMING_AREAS[m.group(1)]
    return None

def discard_change(root: Path, change_id: str) -> None:
    d = change_dir(root, change_id)
    if not d.exists():
        raise CabbageError(f"change `{change_id}` does not exist")
    shutil.rmtree(d)

def adopt_project(root: Path, apply: bool = False) -> dict:
    project_root(root)
    load_config(root)
    rows=[]; counts={"migrate":0,"import":0,"keep":0,"review":0}
    docs_name=load_config(root).get("docs",{}).get("dir","docs")
    for rel in iter_adoption_docs(root):
        area=conforming_area(rel,docs_name)
        if area:
            action,category,target="keep",area,None
        else:
            action,category,target=classify_adoption_doc(rel)
        counts[action]+=1
        rows.append({"path":str(rel).replace("\\","/"),"action":action,"category":category,"target":target})

    applied = []
    warnings = []
    if apply:
        for r in rows:
            if r["action"] in {"migrate", "import"} and r["target"]:
                src_path = root / r["path"]
                dst_dir = root / r["target"]
                dst_dir.mkdir(parents=True, exist_ok=True)
                dst_path = dst_dir / src_path.name
                if not dst_path.exists():
                    shutil.move(str(src_path), str(dst_path))
                    if r["action"] == "migrate":
                        try:
                            text = dst_path.read_text(encoding="utf-8")
                            if not text.startswith("---\n"):
                                fm = f"---\ncategory: {r['category']}\nadopted_at: {now_iso()}\n---\n\n"
                                dst_path.write_text(fm + text, encoding="utf-8")
                        except (OSError, UnicodeDecodeError) as e:
                            warnings.append(f"{dst_path.relative_to(root)}: frontmatter not added ({e})")
                    applied.append({"from": r["path"], "to": str(dst_path.relative_to(root)).replace("\\", "/")})

        if applied:
            # Re-scan after applying
            res = adopt_project(root, apply=False)
            res["applied"] = applied
            res["warnings"] = warnings + res.get("warnings", [])
            return res

    report=render_adoption_report(root,rows)
    out=root/CABBAGE_DIR/"adoption-report.md"
    out.parent.mkdir(parents=True,exist_ok=True)
    out.write_text(report,encoding="utf-8")
    return {"report":str(out.relative_to(root)),"counts":counts,"documents":rows, "applied": applied, "warnings": warnings}

def render_adoption_report(root: Path, rows: list[dict]) -> str:
    docs_name=load_config(root).get("docs",{}).get("dir","docs")
    lines=[
        "---",
        "cabbage_stage: adoption",
        f"generated_at: {now_iso()}",
        "---",
        "",
        "# Adoption report",
        "",
        "Inventory of existing documentation. This report is advisory only; no files were moved.",
        "",
        "## Action legend",
        "",
        "| Action | Meaning |",
        "|---|---|",
        "| keep | Already inside the standard current-state tree; no move needed |",
        "| migrate | Current-state document; move into the standard tree during adoption |",
        "| import | Historical record (ADR/RFC/incident); archive as-is under the standard tree |",
        "| review | Unclassified; a human decides whether to migrate, import, or leave it |",
        "",
        "## Documents",
        "",
        "| Path | Action | Category | Suggested target |",
        "|---|---|---|---|",
    ]
    for r in rows:
        lines.append(f"| `{r['path']}` | {r['action']} | {r['category'] or '-'} | `{r['target'] or '-'}` |")
    lines+=[
        "",
        "## Adoption steps",
        "",
        "1. Resolve each `review` row by hand, then re-run this command.",
        "2. Move `migrate` rows into their suggested target and fix intra-project links.",
        "3. Import `import` rows as immutable history: do not rewrite their content.",
        "4. Record completed moves in a change record (`cabbage new change adopt-existing-docs`).",
        "5. Verify the current-state site (`cabbage docs build`), then enable CI gates.",
        "",
        f"The standard current-state tree is `{docs_name}/`; see the cabbage-docs skill for the layout.",
        "",
    ]
    return "\n".join(lines)
