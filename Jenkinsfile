pipeline {
  agent any

  options {
    timestamps()
    ansiColor('xterm')
    buildDiscarder(logRotator(numToKeepStr: '20'))
  }

  environment {
    PYTHONUNBUFFERED = '1'
    PIP_DISABLE_PIP_VERSION_CHECK = '1'
    CI = 'true'
  }

  stages {
    stage('Checkout') {
      steps {
        checkout scm
      }
    }

    stage('Workspace Info') {
      steps {
        sh '''
          set -eu
          pwd
          ls -la
          echo "Branch: ${BRANCH_NAME:-local}"
          echo "Commit: ${GIT_COMMIT:-unknown}"
        '''
      }
    }

    stage('Backend Unit and API Tests') {
      steps {
        sh 'sh tools/ci/scripts/run-backend-tests.sh'
      }
      post {
        always {
          junit allowEmptyResults: true, testResults: 'reports/backend-pytest.xml'
        }
      }
    }

    stage('UI Tests') {
      steps {
        sh 'sh tools/ci/scripts/run-ui-tests.sh'
      }
      post {
        always {
          junit allowEmptyResults: true, testResults: 'reports/ui-playwright.xml'
        }
      }
    }

    stage('Compose Config Checks') {
      steps {
        sh 'sh tools/ci/scripts/check-compose.sh'
      }
    }

    stage('Security Checks') {
      steps {
        sh 'sh tools/ci/scripts/security-checks.sh'
      }
    }
  }

  post {
    always {
      archiveArtifacts allowEmptyArchive: true, artifacts: 'reports/**'
    }
    success {
      echo 'CI pipeline passed.'
    }
    failure {
      echo 'CI pipeline failed. Check the failed stage above.'
    }
  }
}
