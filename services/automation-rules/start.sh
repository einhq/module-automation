# automation-rules — runs the rules under /etc/automation/rules, each as its file's owner. The
# automation group, whose members write them, is made here the first time.
group-exists automation || group-create automation --title Automation --description "May write the rules under /etc/automation/rules"
automation-rules
